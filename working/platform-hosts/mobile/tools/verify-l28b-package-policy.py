#!/usr/bin/env python3
"""Verify L28-B CSP, local MathJax, and native safety markers in APK and HAP."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import re
import sys
import zipfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit


SHA256 = re.compile(r"^[a-f0-9]{64}$")
PACKAGE_LAYOUT = (("APK", "assets/public/"), ("HAP", "resources/rawfile/web/"))
MOBILE_ROOT = Path(__file__).resolve().parents[1]
RELEASE_RUNTIME_CONFIG = MOBILE_ROOT / "config/runtime.release.json"
STATIC_CSP = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-eval'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "frame-src": ["'none'"],
}
HTML_VOID_ELEMENTS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "param", "source", "track", "wbr",
}
ACTIVE_HEAD_CHILDREN = {"meta", "title", "link", "script"}
EXPECTED_DOCUMENT_ELEMENTS = [
    ("html", None),
    ("head", "html"),
    ("meta", "head"),
    ("meta", "head"),
    ("title", "head"),
    ("meta", "head"),
    ("link", "head"),
    ("script", "head"),
    ("script", "head"),
    ("body", "html"),
    ("div", "body"),
    ("noscript", "body"),
    ("script", "body"),
    ("script", "body"),
    ("script", "body"),
]
EXPECTED_SCRIPT_SOURCES = [
    "./mathjax-config.js",
    "./vendor/mathjax/es5/tex-chtml.js",
    "./vendor/vue.global.prod.js",
    "./mobile-config.js",
    "./mobile-entry.js",
]
NETWORK_MARKERS = [
    "startNativeNetworkRecovery",
    "stopNativeNetworkRecovery",
    "subscribeNetworkStatus",
    "lastExplicitNativeNetworkAvailability",
    "retryContributions();",
    "if (pendingRoomReconnect) startPendingRoomReconnect();",
    'else if (roomStatus.value === "offline") scheduleReconnect();',
    "System availability is only a retry signal.",
]
ANDROID_REPLAY_MARKERS = [
    "LifelineReplayImportPlugin", "LifelineReplayImport", "selectReplay", "handleDocumentPicker",
    "pickerActive", "activeCallId", "android.intent.action.OPEN_DOCUMENT",
    "android.intent.category.OPENABLE", "application/json", "text/json", "text/plain",
    "application/octet-stream", "selected", "cancelled", "too-large", "busy", "read-failed",
    "Replay file selection is already active.", "Invalid replay import request.",
]
HARMONY_REPLAY_MARKERS = [
    "LifelineNativeProxy", "importReplay", "replayImport", "executeImportReplay", "activeImportId",
    "DocumentViewPicker", "fileSuffixFilters", ".json", "maxSelectNumber", "selected", "cancelled",
    "too-large", "Replay file selection is already active.", "Invalid replay import request.",
    "Replay owner changed.", "Replay selection was invalid.",
]
HARMONY_WATCHDOG_MARKERS = [
    "HostContentRecovery", "MAIN_PAGE_LOAD_TIMEOUT_MS", "RECOVERY_PAGE_LOAD_TIMEOUT_MS",
    "主页面加载超时", "恢复页面加载超时", "LIFELINE recovery page load timed out.", "pages/HostRecovery",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def normalized_origin(value: str, *, cli: bool = False) -> str:
    """Accept only a bare HTTPS/WSS origin; reject paths, credentials and wildcards."""
    label = "--allow-connect-origin" if cli else "CSP connect-src"
    require(isinstance(value, str) and value and "*" not in value and "\\" not in value,
            f"{label} contains an empty or wildcard origin: {value!r}")
    parts = urlsplit(value)
    require(parts.scheme in {"https", "wss"} and parts.hostname is not None,
            f"{label} origin must use HTTPS or WSS: {value!r}")
    require(parts.username is None and parts.password is None and parts.path in {"", "/"}
            and parts.query == "" and parts.fragment == "",
            f"{label} must be a bare origin without credentials, path, query, or fragment: {value!r}")
    try:
        port = parts.port
    except ValueError as error:
        raise RuntimeError(f"{label} has an invalid port: {value!r}") from error
    host = parts.hostname.lower()
    require(host and not any(char.isspace() for char in host), f"{label} has an invalid host: {value!r}")
    default_port = 443
    if ":" in host:  # urlsplit() removes the brackets from IPv6 literals.
        host = f"[{host}]"
    suffix = f":{port}" if port is not None and port != default_port else ""
    return f"{parts.scheme}://{host}{suffix}"


def validate_runtime_endpoint(value: str, scheme: str, pathname: str | None, label: str) -> str:
    require(isinstance(value, str) and value and "*" not in value and "\\" not in value,
            f"Release runtime {label} is empty or contains an unsafe character")
    parts = urlsplit(value)
    require(parts.scheme == scheme and parts.hostname is not None,
            f"Release runtime {label} must use {scheme}")
    require(parts.username is None and parts.password is None and not parts.query and not parts.fragment,
            f"Release runtime {label} must not contain credentials, query, or fragment")
    if pathname is None:
        require(parts.path in {"", "/"}, f"Release runtime {label} must be an origin without a path")
    else:
        require(parts.path == pathname, f"Release runtime {label} does not match the required path {pathname}")
    host = parts.hostname.lower()
    require(host != "localhost" and not host.endswith(".localhost") and "%" not in host,
            f"Release runtime {label} cannot use a local or scoped host")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    require(address is None or (not address.is_loopback and not address.is_unspecified),
            f"Release runtime {label} cannot use a loopback or unspecified address")
    try:
        _ = parts.port
    except ValueError as error:
        raise RuntimeError(f"Release runtime {label} has an invalid port") from error
    return normalized_origin(f"{parts.scheme}://{parts.netloc}")


def load_release_runtime_config() -> tuple[dict, set[str], str, bytes]:
    raw = RELEASE_RUNTIME_CONFIG.read_bytes()
    config = json.loads(raw.decode("utf-8-sig"))
    require(isinstance(config, dict) and set(config) == {
        "environment", "apiBaseUrl", "websocketUrl", "trainingContributionUrl",
    }, "Release runtime config must contain exactly the four reviewed fields")
    require(config.get("environment") == "release", "Package policy only accepts the release runtime config")
    origins = {
        validate_runtime_endpoint(config.get("apiBaseUrl"), "https", None, "apiBaseUrl"),
        validate_runtime_endpoint(config.get("websocketUrl"), "wss", "/ws", "websocketUrl"),
        validate_runtime_endpoint(config.get("trainingContributionUrl"), "https",
                                  "/api/training/contributions", "trainingContributionUrl"),
    }
    compact = json.dumps(config, ensure_ascii=False, separators=(",", ":"))
    generated = (
        "globalThis.__LIFELINE_MOBILE_APP__ = true;\n"
        f"globalThis.__LIFELINE_RUNTIME_CONFIG__ = Object.freeze({compact});\n"
    ).encode("utf-8")
    return config, origins, sha256_bytes(raw), generated


class PolicyHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.csp_values: list[str] = []
        self.csp_positions: list[int] = []
        self.controlled_resource_positions: list[tuple[str, int]] = []
        self.inline_handler_attributes: list[tuple[str, str]] = []
        self.elements: list[dict[str, object]] = []
        self.scripts: list[dict[str, str | bool]] = []
        self._script: dict[str, str | bool] | None = None
        self._position = 0
        self._element_stack: list[str] = []
        self._html_open = False
        self._html_start_count = 0
        self._html_end_count = 0
        self._head_open = False
        self._head_start_count = 0
        self._head_end_count = 0
        self._body_open = False
        self._body_start_count = 0
        self._body_end_count = 0
        self._inert_stack: list[str] = []
        self._doctype_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._position += 1
        tag_name = tag.lower()
        attr_map: dict[str, str] = {}
        for name, value in attrs:
            attribute = name.lower()
            require(attribute not in attr_map,
                    f"index.html {tag_name} tag contains duplicate {attribute!r} attributes")
            attr_map[attribute] = value or ""
            if attribute.startswith("on"):
                self.inline_handler_attributes.append((tag_name, attribute))
        if tag_name == "html":
            require(not self._element_stack, "index.html html element must be the document root")
            require(not self._html_open and self._html_start_count == 0,
                    "index.html must contain one non-nested html element")
            require(self._head_start_count == 0 and self._body_start_count == 0,
                    "index.html html element must precede head and body")
            self._html_open = True
            self._html_start_count += 1
        else:
            require(self._html_open, f"index.html {tag_name} must be inside the html element")
        if tag_name == "head":
            require(self._element_stack == ["html"],
                    "index.html head element must be a direct child of html")
            require(self._html_open and self._body_start_count == 0,
                    "index.html head element must be inside html and before body")
            require(not self._head_open and self._head_start_count == 0,
                    "index.html must contain one non-nested head element")
            self._head_open = True
            self._head_start_count += 1
        if tag_name == "body":
            require(self._element_stack == ["html"],
                    "index.html body element must be a direct child of html")
            require(self._html_open and not self._head_open
                    and self._head_start_count == 1 and self._head_end_count == 1,
                    "index.html body element must follow one explicitly closed head element")
            require(not self._body_open and self._body_start_count == 0,
                    "index.html must contain one non-nested body element")
            self._body_open = True
            self._body_start_count += 1
        if tag_name not in {"html", "head", "body"}:
            require(self._head_open or self._body_open,
                    f"index.html {tag_name} must be inside the active head or body element")
        parent = self._element_stack[-1] if self._element_stack else None
        if self._head_open and tag_name != "head":
            require(parent == "head" and tag_name in ACTIVE_HEAD_CHILDREN,
                    f"index.html {tag_name} is not an allowed direct child of active head")
        if tag_name in {"template", "noscript"}:
            self._inert_stack.append(tag_name)
        if tag_name == "meta" and attr_map.get("http-equiv", "").lower() == "content-security-policy":
            require(self._head_open and parent == "head" and not self._inert_stack,
                    "index.html CSP meta must be inside the active head element")
            self.csp_values.append(attr_map.get("content", ""))
            self.csp_positions.append(self._position)
        if tag_name in {"link", "script"}:
            require((self._head_open or self._body_open) and not self._inert_stack,
                    f"index.html {tag_name} must be in the active head or body context")
            self.controlled_resource_positions.append((tag_name, self._position))
        if tag_name == "link":
            require(parent == "head", "index.html link resource must be a direct child of head")
        if tag_name == "script":
            require(parent in {"head", "body"},
                    "index.html executable script must be a direct child of head or body")
        if tag_name == "script":
            self.scripts.append({
                "src": attr_map.get("src", ""),
                "has_src": "src" in attr_map,
                "inline": False,
                "position": self._position,
                "closed": False,
            })
            self._script = self.scripts[-1]
        self.elements.append({"tag": tag_name, "parent": parent, "attrs": attr_map})
        if tag_name not in HTML_VOID_ELEMENTS:
            self._element_stack.append(tag_name)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        require(tag.lower() in HTML_VOID_ELEMENTS,
                f"index.html cannot self-close non-void {tag.lower()} element")
        self.handle_starttag(tag, attrs)

    def handle_data(self, data: str) -> None:
        if self._script is not None and data.strip():
            self._script["inline"] = True
        elif data.strip():
            parent = self._element_stack[-1] if self._element_stack else None
            require(parent in {"title", "noscript"},
                    f"index.html contains unexpected visible text in {parent or 'document'} context")

    def handle_decl(self, decl: str) -> None:
        require(decl.strip().lower() == "doctype html", "index.html must use the HTML5 doctype")
        require(not self.elements and not self._html_open,
                "index.html HTML5 doctype must precede the document element")
        self._doctype_count += 1

    def handle_pi(self, data: str) -> None:
        raise RuntimeError("index.html processing instructions are not allowed")

    def handle_comment(self, data: str) -> None:
        raise RuntimeError("index.html comments are not allowed in the generated mobile entry")

    def unknown_decl(self, data: str) -> None:
        raise RuntimeError("index.html unknown declarations are not allowed")

    def handle_endtag(self, tag: str) -> None:
        tag_name = tag.lower()
        require(tag_name not in HTML_VOID_ELEMENTS,
                f"index.html cannot explicitly close void {tag_name} element")
        require(self._element_stack and self._element_stack[-1] == tag_name,
                f"index.html closes {tag_name} outside matching element context")
        if tag_name == "script":
            require(self._script is not None, "index.html closes script without an open script element")
            self._script["closed"] = True
            self._script = None
        if tag_name in {"template", "noscript"}:
            require(self._inert_stack and self._inert_stack[-1] == tag_name,
                    f"index.html closes {tag_name} outside matching inert context")
            self._inert_stack.pop()
        if tag_name == "head":
            require(self._head_open, "index.html closes head without an open head element")
            self._head_open = False
            self._head_end_count += 1
        if tag_name == "body":
            require(self._body_open, "index.html closes body without an open body element")
            self._body_open = False
            self._body_end_count += 1
        if tag_name == "html":
            require(self._html_open and not self._head_open and not self._body_open,
                    "index.html closes html before head and body are closed")
            self._html_open = False
            self._html_end_count += 1
        self._element_stack.pop()

    def require_complete_document_structure(self) -> None:
        require(self._doctype_count == 1, "index.html must contain exactly one HTML5 doctype")
        require(self._html_start_count == 1 and self._html_end_count == 1 and not self._html_open,
                "index.html must contain one explicitly closed html element")
        require(self._head_start_count == 1 and self._head_end_count == 1 and not self._head_open,
                "index.html must contain one explicitly closed head element")
        require(self._body_start_count == 1 and self._body_end_count == 1 and not self._body_open,
                "index.html must contain one explicitly closed body element")
        require(not self._inert_stack, "index.html contains an unclosed template or noscript element")
        require(not self._element_stack, "index.html contains unclosed or mis-nested elements")


def parse_csp(policy: str, label: str, allowed_origins: set[str]) -> dict[str, list[str]]:
    directives: dict[str, list[str]] = {}
    for raw in policy.split(";"):
        fields = raw.strip().split()
        if not fields:
            continue
        name = fields[0].lower()
        require(name not in directives, f"{label} CSP repeats directive {name}")
        require(len(fields) > 1, f"{label} CSP directive has no source list: {name}")
        directives[name] = fields[1:]

    expected_names = set(STATIC_CSP) | {"connect-src"}
    require(set(directives) == expected_names,
            f"{label} CSP directive set differs: expected {sorted(expected_names)}, got {sorted(directives)}")
    for name, expected in STATIC_CSP.items():
        require(directives[name] == expected,
                f"{label} CSP {name} differs from the exact mobile policy: {directives[name]}")

    connect = directives["connect-src"]
    require(connect.count("'self'") == 1, f"{label} CSP connect-src must contain exactly one 'self'")
    origins = connect[1:] if connect and connect[0] == "'self'" else [item for item in connect if item != "'self'"]
    require(len(origins) == len(set(origins)), f"{label} CSP connect-src contains duplicate origins")
    canonical = {normalized_origin(origin) for origin in origins}
    require(len(canonical) == len(origins) and all(origin == normalized_origin(origin) for origin in origins),
            f"{label} CSP connect-src origins must be unique, canonical bare origins")
    require(canonical == allowed_origins,
            f"{label} CSP connect-src origins differ from the CLI allowlist: expected {sorted(allowed_origins)}, got {sorted(canonical)}")
    require(connect == ["'self'", *origins], f"{label} CSP connect-src must place 'self' first and use bare origins")
    return directives


def read_member(archive: zipfile.ZipFile, name: str, label: str) -> bytes:
    try:
        return archive.read(name)
    except KeyError as error:
        raise RuntimeError(f"{label} is missing package member {name}") from error


def require_markers(payload: bytes, markers: list[str], label: str) -> None:
    missing = [marker for marker in markers if marker.encode("utf-8") not in payload]
    require(not missing, f"{label} is missing required compiled markers: {missing}")


def inspect_html(index_bytes: bytes, label: str, allowed_origins: set[str], expected_mathjax_hash: str) -> dict:
    index = index_bytes.decode("utf-8-sig")
    parser = PolicyHTMLParser()
    parser.feed(index)
    parser.close()
    parser.require_complete_document_structure()
    actual_elements = [(str(item["tag"]), item["parent"]) for item in parser.elements]
    require(actual_elements == EXPECTED_DOCUMENT_ELEMENTS,
            f"{label} index.html element skeleton differs from the generated mobile entry: {actual_elements}")
    attrs = [item["attrs"] for item in parser.elements]
    require(attrs[0] == {"lang": "zh-CN"} and attrs[1] == {},
            f"{label} index.html html/head attributes differ from the generated entry")
    require(attrs[2] == {"charset": "UTF-8"},
            f"{label} index.html charset meta differs from the generated entry")
    require(attrs[3] == {"name": "viewport", "content": "width=device-width, initial-scale=1.0"},
            f"{label} index.html viewport meta differs from the generated entry")
    require(attrs[4] == {}, f"{label} index.html title attributes are not allowed")
    require(set(attrs[5]) == {"http-equiv", "content"}
            and attrs[5]["http-equiv"].lower() == "content-security-policy",
            f"{label} index.html CSP meta attributes differ from the generated entry")
    require(set(attrs[6]) == {"rel", "href"} and attrs[6]["rel"].lower() == "stylesheet"
            and re.fullmatch(r"\./styles\.css\?v=[A-Za-z0-9._-]+", attrs[6]["href"]) is not None,
            f"{label} index.html stylesheet link differs from the generated entry")
    require(attrs[7] == {"src": EXPECTED_SCRIPT_SOURCES[0]},
            f"{label} index.html MathJax configuration script attributes differ")
    require(attrs[8] == {"defer": "", "src": EXPECTED_SCRIPT_SOURCES[1]},
            f"{label} index.html MathJax engine script attributes differ")
    require(attrs[9] == {} and attrs[10] == {"id": "app"} and attrs[11] == {},
            f"{label} index.html body/app/noscript attributes differ from the generated entry")
    require(attrs[12] == {"src": EXPECTED_SCRIPT_SOURCES[2]}
            and attrs[13] == {"src": EXPECTED_SCRIPT_SOURCES[3]}
            and attrs[14] == {"type": "module", "src": EXPECTED_SCRIPT_SOURCES[4]},
            f"{label} index.html application script attributes differ from the generated entry")
    require(len(parser.csp_values) == 1, f"{label} index.html must contain exactly one CSP meta tag")
    require(not parser.inline_handler_attributes,
            f"{label} index.html contains inline event handlers: {parser.inline_handler_attributes}")
    require(parser.controlled_resource_positions,
            f"{label} index.html contains no link or script resources protected by the CSP")
    first_resource_position = min(position for _, position in parser.controlled_resource_positions)
    require(parser.csp_positions[0] < first_resource_position,
            f"{label} CSP meta must appear before the first link or script resource")
    directives = parse_csp(parser.csp_values[0], label, allowed_origins)
    require(parser.scripts, f"{label} index.html contains no script tags")
    script_sources = []
    script_member_paths = []
    for script in parser.scripts:
        require(script["closed"], f"{label} index.html contains an unclosed script element")
        require(script["has_src"] and not script["inline"], f"{label} index.html contains an inline or source-less script")
        src = str(script["src"])
        require(src and not re.match(r"^(?:https?:)?//", src, re.IGNORECASE),
                f"{label} index.html contains a remote script tag: {src!r}")
        parsed = urlsplit(src)
        require(not parsed.scheme and not parsed.netloc and not parsed.query and not parsed.fragment
                and not src.startswith(("/", "data:", "blob:")) and "\\" not in src and "%" not in src,
                f"{label} index.html script is not a local relative resource: {src!r}")
        relative = PurePosixPath(parsed.path)
        require(parsed.path and not relative.is_absolute() and ".." not in relative.parts
                and relative.as_posix() not in {"", "."},
                f"{label} index.html script escapes or omits the packaged Web root: {src!r}")
        script_sources.append(src)
        script_member_paths.append(relative.as_posix())
    require(script_sources == EXPECTED_SCRIPT_SOURCES,
            f"{label} index.html script order differs from the generated mobile entry: {script_sources}")
    mathjax_config_positions = [int(script["position"]) for script in parser.scripts
                                if script["src"] in {"./mathjax-config.js", "mathjax-config.js"}]
    mathjax_engine_positions = [int(script["position"]) for script in parser.scripts
                                if script["src"] in {"./vendor/mathjax/es5/tex-chtml.js",
                                                     "vendor/mathjax/es5/tex-chtml.js"}]
    require(len(mathjax_config_positions) == 1,
            f"{label} index.html must load local mathjax-config.js exactly once")
    require(len(mathjax_engine_positions) == 1,
            f"{label} index.html must load the local MathJax engine exactly once")
    require(mathjax_config_positions[0] < mathjax_engine_positions[0],
            f"{label} mathjax-config.js must load before the local MathJax engine")
    return {
        "csp_sha256": sha256_bytes(parser.csp_values[0].encode("utf-8")),
        "csp_directives": directives,
        "script_tag_count": len(parser.scripts),
        "script_sources": script_sources,
        "script_member_paths": script_member_paths,
        "inline_scripts": 0,
        "remote_script_tags": 0,
        "mathjax_config_sha256": expected_mathjax_hash,
        "csp_before_first_resource": True,
        "mathjax_config_precedes_engine": True,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path, help="APK to inspect")
    parser.add_argument("--hap", required=True, type=Path, help="HAP to inspect")
    parser.add_argument("--expected-mathjax-config-sha256", required=True,
                        help="Expected SHA-256 of the packaged mathjax-config.js")
    parser.add_argument("--output", type=Path, help="Optional JSON receipt path; existing files are never overwritten")
    return parser.parse_args()


def verify_package(label: str, package_path: Path, prefix: str,
                   allowed_origins: set[str], expected_mathjax_hash: str,
                   expected_mobile_config: bytes) -> dict:
    with zipfile.ZipFile(package_path, "r", metadata_encoding="utf-8") as archive:
        archive_names = archive.namelist()
        duplicate_members = sorted(name for name, count in Counter(archive_names).items() if count > 1)
        require(not duplicate_members, f"{label} contains duplicate ZIP members: {duplicate_members}")
        names = set(archive_names)
        index = read_member(archive, prefix + "index.html", label)
        html_result = inspect_html(index, label, allowed_origins, expected_mathjax_hash)
        missing_scripts = [path for path in html_result["script_member_paths"] if prefix + path not in names]
        require(not missing_scripts, f"{label} is missing local scripts referenced by index.html: {missing_scripts}")
        mobile_config = read_member(archive, prefix + "mobile-config.js", label)
        require(mobile_config == expected_mobile_config,
                f"{label} mobile-config.js differs from the validated release runtime config")
        mathjax = read_member(archive, prefix + "mathjax-config.js", label)
        mathjax_hash = sha256_bytes(mathjax)
        require(mathjax_hash == expected_mathjax_hash,
                f"{label} mathjax-config.js SHA-256 does not match --expected-mathjax-config-sha256")

        online_app = read_member(archive, prefix + "OnlineApp.js", label)
        require_markers(online_app, NETWORK_MARKERS, f"{label} native network recovery path")

        result: dict[str, object] = {
            "kind": label,
            "path": str(package_path),
            "bytes": package_path.stat().st_size,
            "sha256": sha256_file(package_path),
            "index_html_sha256": sha256_bytes(index),
            "mathjax_config_sha256": mathjax_hash,
            "mobile_config_sha256": sha256_bytes(mobile_config),
            "web_policy": html_result,
            "native_network_recovery": {"verified": True, "markers": NETWORK_MARKERS},
        }

        if label == "APK":
            dex_entries = sorted(name for name in names if re.fullmatch(r"classes\d*\.dex", name))
            dex_match = next((name for name in dex_entries
                              if all(marker.encode("utf-8") in archive.read(name)
                                     for marker in ANDROID_REPLAY_MARKERS)), None)
            require(dex_match is not None,
                    "APK DEX lacks the replay picker plugin, selectReplay flow, busy rejection, or refusal text")
            result["android_replay_import"] = {
                "dex_entry": dex_match,
                "verified": True,
                "markers": ANDROID_REPLAY_MARKERS,
            }
        else:
            abc_entries = sorted(name for name in names if name.endswith(".abc"))
            replay_match = next((name for name in abc_entries
                                 if all(marker.encode("utf-8") in archive.read(name)
                                        for marker in HARMONY_REPLAY_MARKERS)), None)
            require(replay_match is not None,
                    "Harmony ABC lacks the replay import bridge, activeImportId lock, or duplicate-selection refusal copy")
            watchdog_match = next((name for name in abc_entries
                                   if all(marker.encode("utf-8") in archive.read(name)
                                          for marker in HARMONY_WATCHDOG_MARKERS)), None)
            require(watchdog_match is not None,
                    "Harmony ABC lacks bounded main/recovery-page watchdog markers")
            result["harmony_replay_import"] = {
                "abc_entry": replay_match,
                "verified": True,
                "markers": HARMONY_REPLAY_MARKERS,
            }
            result["harmony_host_watchdog"] = {
                "abc_entry": watchdog_match,
                "verified": True,
                "markers": HARMONY_WATCHDOG_MARKERS,
            }
        return result


def main() -> int:
    args = parse_args()
    require(SHA256.fullmatch(args.expected_mathjax_config_sha256) is not None,
            "--expected-mathjax-config-sha256 must be 64 lowercase hexadecimal characters")
    expected_hash = args.expected_mathjax_config_sha256
    runtime_config, allowed_origins, runtime_config_hash, expected_mobile_config = load_release_runtime_config()
    packages = []
    for label, package_arg, prefix in (("APK", args.apk, PACKAGE_LAYOUT[0][1]),
                                       ("HAP", args.hap, PACKAGE_LAYOUT[1][1])):
        package_path = package_arg.resolve()
        require(package_path.is_file(), f"{label} not found: {package_path}")
        packages.append(verify_package(label, package_path, prefix, allowed_origins, expected_hash,
                                       expected_mobile_config))

    require(packages[0]["mathjax_config_sha256"] == packages[1]["mathjax_config_sha256"],
            "APK and HAP mathjax-config.js hashes differ")
    result = {
        "schema": "lifeline-mobile-l28b-package-policy-v1",
        "status": "PASS_L28B_NATIVE_PACKAGE_POLICY",
        "expected_mathjax_config_sha256": expected_hash,
        "release_runtime_config": str(RELEASE_RUNTIME_CONFIG),
        "release_runtime_config_sha256": runtime_config_hash,
        "release_runtime_environment": runtime_config["environment"],
        "allowed_connect_origins": sorted(allowed_origins),
        "packages": packages,
        "scope": "APK/HAP package CSP, local scripts, MathJax hash, network recovery, replay import, and Harmony watchdog verification; no device execution, signing, store, or release acceptance claim.",
    }
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        output = args.output.resolve()
        require(not output.exists(), f"Refusing to overwrite existing JSON receipt: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"L28-B package policy rejected: {error}", file=sys.stderr)
        raise SystemExit(1)
