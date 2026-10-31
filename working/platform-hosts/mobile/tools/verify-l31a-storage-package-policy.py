#!/usr/bin/env python3
"""Verify the L31-A Android-storage candidate's source and package bindings.

This policy checks canonical Web-receipt source hashes, the exercised Android
session-store receipt, static APK/HAP verification receipts, Android DEX
storage symbols, Harmony package identity, and input stability. It does not
build packages or establish device, signing, installation, or store acceptance.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import struct
import sys
import zipfile
from pathlib import Path, PurePosixPath


POLICY_STATUS = "PASS_L31A_STORAGE_PACKAGE_POLICY"
IDENTITY_CONFIG = "mobile/config/release-identity-candidate.json"
EXPECTED_ANDROID = {
    "applicationId": "cn.lifelinegame.mobile",
    "versionCode": 2,
    "versionName": "1.0.1",
}
EXPECTED_HARMONY = {
    "bundleName": "cn.lifelinegame.mobile.harmony",
    "versionCode": 2,
    "versionName": "1.0.1",
}
REQUIRED_SOURCE_PATHS = [
    "mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineStoragePlugin.java",
    "mobile/tests/verify-android-session-store.py",
    "mobile/tests/verify-android-credential-store.py",
    "mobile/tools/verify-l31a-storage-package-policy.py",
    "mobile/tools/verify-l26-android-apk.py",
    "mobile/tools/verify-l26-harmony-hap.py",
    "mobile/config/release-identity-candidate.json",
    "mobile/tools/release-identity.mjs",
    "mobile/tools/release-identity-data.mjs",
    "mobile/android/app/build.gradle",
    "mobile/harmony/AppScope/app.json5",
    "mobile/tools/build-web.mjs",
]
PLUGIN_DESCRIPTOR = "Lcn/lifelinegame/mobile/LifelineStoragePlugin;"
REQUIRED_PLUGIN_METHODS = {
    "loadRecord", "saveRecord", "removeRecord", "readRaw", "writeDurably",
    "readAtomic", "readCredentialAtomic", "writeAtomic",
}
REQUIRED_DEX_METHOD_REFS = {
    ("Landroid/util/AtomicFile;", "openRead"),
    ("Landroid/util/AtomicFile;", "getBaseFile"),
    ("Landroid/util/AtomicFile;", "startWrite"),
    ("Landroid/util/AtomicFile;", "finishWrite"),
    ("Landroid/util/AtomicFile;", "failWrite"),
    ("Ljava/io/FileOutputStream;", "getFD"),
    ("Ljava/io/FileDescriptor;", "sync"),
    ("Ljava/io/File;", "exists"),
    ("Ljava/lang/String;", "equals"),
}
FILE_NOT_FOUND_DESCRIPTOR = "Ljava/io/FileNotFoundException;"
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def safe_relative(value: str) -> str:
    require(isinstance(value, str) and value and "\\" not in value,
            f"Unsafe receipt source path: {value!r}")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts and path.as_posix() != ".",
            f"Unsafe receipt source path: {value!r}")
    return path.as_posix()


def indexed_hash_rows(rows: object, label: str) -> dict[str, str]:
    require(isinstance(rows, list), f"{label} must be a list")
    indexed: dict[str, str] = {}
    for row in rows:
        require(isinstance(row, dict), f"{label} contains a non-object row")
        relative = safe_relative(row.get("path", ""))
        digest = row.get("sha256")
        require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None,
                f"{label} has an invalid SHA-256 for {relative}")
        require(relative not in indexed, f"{label} contains duplicate path {relative}")
        indexed[relative] = digest
    return indexed


def verify_source_bindings(receipt: dict, source_bytes: dict[str, bytes]) -> dict[str, str]:
    require(receipt.get("schema") == "lifeline-mobile-web-build-v1",
            "Unexpected canonical Web receipt schema")
    require(receipt.get("status") == "PASS-CURRENT", "Canonical Web receipt is not PASS-CURRENT")
    rows = indexed_hash_rows(receipt.get("source_files"), "Canonical receipt source_files")
    verified: dict[str, str] = {}
    for relative in REQUIRED_SOURCE_PATHS:
        payload = source_bytes.get(relative)
        require(payload is not None, f"Required source input was not snapshotted: {relative}")
        digest = sha256_bytes(payload)
        require(rows.get(relative) == digest,
                f"Canonical receipt does not bind the current source hash: {relative}")
        verified[relative] = digest
    return verified


def verify_session_store_receipt(report: object, storage_source_sha: str) -> None:
    require(isinstance(report, dict), "Android session-store verification receipt is not an object")
    require(report.get("status") == "PASS", "Android session-store verifier did not pass")
    require(str(report.get("source_sha256", "")).lower() == storage_source_sha,
            "Android session-store verifier exercised a different Storage source hash")
    require(report.get("checks") == 11, "Android session-store verifier did not complete all 11 checks")
    output = report.get("output")
    require(isinstance(output, list) and len(output) == 11
            and all(isinstance(row, str) and row.startswith("PASS\t") for row in output),
            "Android session-store verifier receipt does not contain 11 passing check rows")


def require_identity_config(identity: object) -> dict:
    require(isinstance(identity, dict), "Release identity config is not an object")
    require(identity.get("schema") == "lifeline-mobile-release-identity-candidate-v1",
            "Unexpected release identity config schema")
    require(identity.get("status") == "DEVELOPMENT_CANDIDATE_NOT_FROZEN",
            "L31-A candidate identity must remain unfrozen")
    android = identity.get("android")
    harmony = identity.get("harmony")
    require(isinstance(android, dict) and isinstance(harmony, dict),
            "Release identity config omits Android or Harmony identity")
    for key, expected in EXPECTED_ANDROID.items():
        require(android.get(key) == expected, f"Release identity Android {key} must be {expected!r}")
    for key, expected in EXPECTED_HARMONY.items():
        require(harmony.get(key) == expected, f"Release identity Harmony {key} must be {expected!r}")
    return identity


def verify_identity_source(report: dict, expected: dict, identity_path: Path, label: str) -> None:
    identity_source = report.get("identitySource")
    require(isinstance(identity_source, dict)
            and identity_source.get("type") == "EXPLICIT_CANDIDATE_CONFIG",
            f"{label} verifier did not use an explicit candidate identity config")
    config_path = identity_source.get("configPath")
    require(isinstance(config_path, str) and Path(config_path).resolve() == identity_path.resolve(),
            f"{label} verifier used a different identity config")
    actual = identity_source.get("identity")
    require(isinstance(actual, dict), f"{label} verifier receipt omits identity fields")
    for key, value in expected.items():
        require(actual.get(key) == value or str(actual.get(key)) == str(value),
                f"{label} verifier identity {key} does not match L31-A")


def verify_android_verifier_receipt(report: dict, expected: dict, identity_path: Path,
                                    receipt_sha: str, apk_sha: str) -> None:
    require(report.get("schema") == "lifeline-l26-android-apk-verification-v1",
            "Unexpected Android static-verifier receipt schema")
    require(report.get("status") == "PASS_ANDROID_DEBUG_APK_L26",
            "Android static verifier did not pass")
    verify_identity_source(report, expected, identity_path, "Android")
    package = report.get("package")
    require(isinstance(package, dict), "Android verifier receipt omits package metadata")
    for key, value in expected.items():
        require(str(package.get(key)) == str(value),
                f"Android package metadata {key} does not match L31-A")
    require(report.get("apk", {}).get("sha256") == apk_sha,
            "Android verifier receipt refers to a different APK hash")
    require(report.get("webBuildReceipt", {}).get("sha256") == receipt_sha,
            "Android verifier receipt refers to a different canonical Web receipt")


def verify_harmony_verifier_receipt(report: dict, expected: dict, identity_path: Path,
                                    receipt_sha: str, hap_sha: str) -> None:
    require(report.get("schema") == "lifeline-l26-harmony-hap-verification-v1",
            "Unexpected Harmony static-verifier receipt schema")
    require(report.get("status") == "PASS_HARMONY_UNSIGNED_HAP_L26",
            "Harmony static verifier did not pass")
    verify_identity_source(report, expected, identity_path, "Harmony")
    app = report.get("app")
    require(isinstance(app, dict), "Harmony verifier receipt omits app metadata")
    for key, value in expected.items():
        require(app.get(key) == value or str(app.get(key)) == str(value),
                f"Harmony package metadata {key} does not match L31-A")
    require(report.get("hap", {}).get("sha256") == hap_sha,
            "Harmony verifier receipt refers to a different HAP hash")
    require(report.get("webBuildReceipt", {}).get("sha256") == receipt_sha,
            "Harmony verifier receipt refers to a different canonical Web receipt")


def verify_harmony_package_metadata(module: object, pack: object, expected: dict) -> None:
    require(isinstance(module, dict) and isinstance(pack, dict), "HAP metadata is malformed")
    app = module.get("app")
    require(isinstance(app, dict), "HAP module.json omits app identity")
    for key, value in expected.items():
        require(app.get(key) == value or str(app.get(key)) == str(value),
                f"HAP module.json {key} does not match L31-A")
    pack_app = pack.get("summary", {}).get("app", {})
    require(isinstance(pack_app, dict), "HAP pack.info omits app identity")
    require(pack_app.get("bundleName") == expected["bundleName"],
            "HAP pack.info bundleName does not match L31-A")
    version = pack_app.get("version")
    require(isinstance(version, dict)
            and str(version.get("code")) == str(expected["versionCode"])
            and version.get("name") == expected["versionName"],
            "HAP pack.info version does not match L31-A")


def read_uleb128(data: bytes, offset: int, label: str) -> tuple[int, int]:
    value = 0
    shift = 0
    for _ in range(5):
        require(offset < len(data), f"DEX {label} is truncated")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7f) << shift
        if byte < 0x80:
            return value, offset
        shift += 7
    raise RuntimeError(f"DEX {label} has an oversized ULEB128 value")


def parse_dex_symbols(data: bytes) -> dict[str, set]:
    require(len(data) >= 112 and data[:4] == b"dex\n" and data[7] == 0,
            "APK DEX has an invalid header")

    def u4(offset: int) -> int:
        require(0 <= offset <= len(data) - 4, "DEX header or table is truncated")
        return struct.unpack_from("<I", data, offset)[0]

    file_size = u4(32)
    require(file_size == len(data), "DEX declared file size differs from its ZIP entry")
    require(u4(36) == 112 and u4(40) == 0x12345678, "DEX header size or endian tag is invalid")

    def table(size_offset: int, data_offset: int, width: int, label: str) -> tuple[int, int]:
        count, offset = u4(size_offset), u4(data_offset)
        require(count <= 1_000_000, f"DEX {label} count is unreasonable")
        require((count == 0 and offset == 0) or (count > 0 and offset >= 112
                and offset + count * width <= file_size), f"DEX {label} table is out of bounds")
        return count, offset

    string_count, string_offset = table(56, 60, 4, "string_ids")
    type_count, type_offset = table(64, 68, 4, "type_ids")
    method_count, method_offset = table(88, 92, 8, "method_ids")
    class_count, class_offset = table(96, 100, 32, "class_defs")

    strings = []
    for index in range(string_count):
        cursor = u4(string_offset + index * 4)
        _, cursor = read_uleb128(data, cursor, "string length")
        end = data.find(b"\x00", cursor, file_size)
        require(end >= 0, "DEX string is not NUL terminated")
        strings.append(data[cursor:end].replace(b"\xc0\x80", b"\x00").decode("utf-8", errors="replace"))

    types = []
    for index in range(type_count):
        string_index = u4(type_offset + index * 4)
        require(string_index < len(strings), "DEX type descriptor index is invalid")
        types.append(strings[string_index])

    methods = []
    for index in range(method_count):
        cursor = method_offset + index * 8
        class_index, _proto_index, name_index = struct.unpack_from("<HHI", data, cursor)
        require(class_index < len(types) and name_index < len(strings), "DEX method id index is invalid")
        methods.append((types[class_index], strings[name_index]))

    defined_classes = set()
    defined_methods = set()
    for index in range(class_count):
        cursor = class_offset + index * 32
        class_index = u4(cursor)
        class_data_offset = u4(cursor + 24)
        require(class_index < len(types), "DEX class definition type index is invalid")
        descriptor = types[class_index]
        defined_classes.add(descriptor)
        if not class_data_offset:
            continue
        static_count, cursor = read_uleb128(data, class_data_offset, "class data")
        instance_count, cursor = read_uleb128(data, cursor, "class data")
        direct_count, cursor = read_uleb128(data, cursor, "class data")
        virtual_count, cursor = read_uleb128(data, cursor, "class data")
        require(static_count + instance_count + direct_count + virtual_count <= 1_000_000,
                "DEX class data item count is unreasonable")
        for _ in range(static_count + instance_count):
            _, cursor = read_uleb128(data, cursor, "encoded field")
            _, cursor = read_uleb128(data, cursor, "encoded field")
        for method_group_count in (direct_count, virtual_count):
            method_index = 0
            for _ in range(method_group_count):
                difference, cursor = read_uleb128(data, cursor, "encoded method")
                _, cursor = read_uleb128(data, cursor, "encoded method")
                _, cursor = read_uleb128(data, cursor, "encoded method")
                method_index += difference
                require(method_index < len(methods), "DEX class data method index is invalid")
                owner, name = methods[method_index]
                require(owner == descriptor, "DEX class data references a method owned by another class")
                defined_methods.add((owner, name))

    return {
        "types": set(types),
        "method_refs": set(methods),
        "defined_classes": defined_classes,
        "defined_methods": defined_methods,
    }


def verify_storage_dex(data: bytes, label: str = "APK") -> None:
    symbols = parse_dex_symbols(data)
    verify_storage_symbols(symbols, label)


def verify_storage_symbols(symbols: dict[str, set], label: str) -> None:
    require(PLUGIN_DESCRIPTOR in symbols["defined_classes"],
            f"{label} DEX does not define LifelineStoragePlugin")
    missing_methods = {(PLUGIN_DESCRIPTOR, name) for name in REQUIRED_PLUGIN_METHODS} - symbols["defined_methods"]
    require(not missing_methods, f"{label} DEX omits plugin storage methods: {sorted(missing_methods)}")
    missing_refs = REQUIRED_DEX_METHOD_REFS - symbols["method_refs"]
    require(not missing_refs, f"{label} DEX omits AtomicFile durability symbols: {sorted(missing_refs)}")
    require(FILE_NOT_FOUND_DESCRIPTOR in symbols["types"],
            f"{label} DEX omits FileNotFoundException handling")


def verify_apk_dex(apk_bytes: bytes) -> str:
    try:
        archive = zipfile.ZipFile(io.BytesIO(apk_bytes), "r")
    except zipfile.BadZipFile as error:
        raise RuntimeError("APK is not a valid ZIP archive") from error
    with archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "APK contains duplicate ZIP entries")
        require(archive.testzip() is None, "APK ZIP CRC verification failed")
        dex_entries = sorted(name for name in names if re.fullmatch(r"classes\d*\.dex", name))
        require(dex_entries, "APK contains no DEX files")
        storage_entries = []
        for name in dex_entries:
            symbols = parse_dex_symbols(archive.read(name))
            if PLUGIN_DESCRIPTOR not in symbols["defined_classes"]:
                continue
            verify_storage_symbols(symbols, f"APK {name}")
            storage_entries.append(name)
        require(len(storage_entries) == 1,
                f"APK must define LifelineStoragePlugin in exactly one DEX, found {storage_entries}")
    return storage_entries[0]


def verify_hap_metadata(hap_bytes: bytes, expected: dict) -> None:
    try:
        archive = zipfile.ZipFile(io.BytesIO(hap_bytes), "r")
    except zipfile.BadZipFile as error:
        raise RuntimeError("HAP is not a valid ZIP archive") from error
    with archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "HAP contains duplicate ZIP entries")
        require(archive.testzip() is None, "HAP ZIP CRC verification failed")
        require({"module.json", "pack.info"} <= set(names), "HAP omits identity metadata")
        module = json.loads(archive.read("module.json").decode("utf-8"))
        pack = json.loads(archive.read("pack.info").decode("utf-8"))
    verify_harmony_package_metadata(module, pack, expected)


def verify_input_stability(before: dict[Path, str]) -> None:
    for path, expected in before.items():
        require(path.is_file(), f"Input disappeared during verification: {path}")
        require(sha256_bytes(path.read_bytes()) == expected,
                f"Input changed during verification: {path}")


def reject(label: str, action) -> None:
    try:
        action()
    except (RuntimeError, ValueError, KeyError, TypeError, struct.error, zipfile.BadZipFile):
        return
    raise RuntimeError(f"Self-test mutation was accepted: {label}")


def encode_uleb128(value: int) -> bytes:
    output = bytearray()
    while True:
        byte = value & 0x7f
        value >>= 7
        if value:
            output.append(byte | 0x80)
        else:
            output.append(byte)
            return bytes(output)


def synthetic_dex(include_sync: bool = True, own_descriptor: str = PLUGIN_DESCRIPTOR) -> bytes:
    own_names = sorted(REQUIRED_PLUGIN_METHODS)
    external = set(REQUIRED_DEX_METHOD_REFS)
    if not include_sync:
        external.remove(("Ljava/io/FileDescriptor;", "sync"))
    descriptors = {
        own_descriptor,
        "Landroid/util/AtomicFile;",
        "Ljava/io/FileOutputStream;",
        "Ljava/io/FileDescriptor;",
        "Ljava/io/File;",
        "Ljava/lang/String;",
        FILE_NOT_FOUND_DESCRIPTOR,
    }
    method_keys = {(own_descriptor, name) for name in own_names} | external
    strings = sorted(descriptors | {name for _, name in method_keys})
    string_index = {value: index for index, value in enumerate(strings)}
    types = sorted(descriptors, key=lambda value: string_index[value])
    type_index = {value: index for index, value in enumerate(types)}
    methods = sorted(method_keys, key=lambda item: (type_index[item[0]], string_index[item[1]]))
    method_indices = {value: index for index, value in enumerate(methods)}

    string_ids_off = 112
    type_ids_off = string_ids_off + len(strings) * 4
    method_ids_off = type_ids_off + len(types) * 4
    class_defs_off = method_ids_off + len(methods) * 8
    data_off = class_defs_off + 32
    data = bytearray()
    string_offsets = []
    for value in strings:
        string_offsets.append(data_off + len(data))
        payload = value.encode("utf-8")
        data += encode_uleb128(len(value)) + payload + b"\x00"
    class_data_off = data_off + len(data)
    own_indices = sorted(method_indices[(own_descriptor, name)] for name in own_names)
    class_data = bytearray(encode_uleb128(0) + encode_uleb128(0)
                           + encode_uleb128(len(own_indices)) + encode_uleb128(0))
    last = 0
    for method_index in own_indices:
        class_data += encode_uleb128(method_index - last) + encode_uleb128(0x2) + encode_uleb128(0)
        last = method_index
    data += class_data

    file_size = data_off + len(data)
    dex = bytearray(file_size)
    dex[:8] = b"dex\n039\x00"
    struct.pack_into("<I", dex, 32, file_size)
    struct.pack_into("<I", dex, 36, 112)
    struct.pack_into("<I", dex, 40, 0x12345678)
    for size_offset, offset_offset, count, offset in (
            (56, 60, len(strings), string_ids_off),
            (64, 68, len(types), type_ids_off),
            (88, 92, len(methods), method_ids_off),
            (96, 100, 1, class_defs_off),
            (104, 108, len(data), data_off)):
        struct.pack_into("<II", dex, size_offset, count, offset)
    for index, string_data_off in enumerate(string_offsets):
        struct.pack_into("<I", dex, string_ids_off + index * 4, string_data_off)
    for index, descriptor in enumerate(types):
        struct.pack_into("<I", dex, type_ids_off + index * 4, string_index[descriptor])
    for index, (owner, name) in enumerate(methods):
        struct.pack_into("<HHI", dex, method_ids_off + index * 8, type_index[owner], 0, string_index[name])
    struct.pack_into("<I", dex, class_defs_off, type_index[own_descriptor])
    struct.pack_into("<I", dex, class_defs_off + 24, class_data_off)
    dex[data_off:] = data
    return bytes(dex)


def candidate_identity_fixture() -> dict:
    return {
        "schema": "lifeline-mobile-release-identity-candidate-v1",
        "status": "DEVELOPMENT_CANDIDATE_NOT_FROZEN",
        "android": dict(EXPECTED_ANDROID),
        "harmony": dict(EXPECTED_HARMONY),
    }


def run_self_test() -> int:
    source_bytes = {relative: f"fixture source {index}".encode("utf-8")
                    for index, relative in enumerate(REQUIRED_SOURCE_PATHS)}
    source_receipt = {
        "schema": "lifeline-mobile-web-build-v1",
        "status": "PASS-CURRENT",
        "source_files": [{"path": name, "sha256": sha256_bytes(payload)}
                         for name, payload in source_bytes.items()],
    }
    verify_source_bindings(source_receipt, source_bytes)
    reject("missing source row", lambda: verify_source_bindings(
        {**source_receipt, "source_files": source_receipt["source_files"][1:]}, source_bytes))
    bad_rows = [dict(row) for row in source_receipt["source_files"]]
    bad_rows[0]["sha256"] = "0" * 64
    reject("source hash drift", lambda: verify_source_bindings(
        {**source_receipt, "source_files": bad_rows}, source_bytes))
    storage_sha = sha256_bytes(source_bytes[REQUIRED_SOURCE_PATHS[0]])
    session_report = {
        "status": "PASS", "source_sha256": storage_sha.upper(), "checks": 11,
        "output": [f"PASS\tfixture check {index}" for index in range(11)],
    }
    verify_session_store_receipt(session_report, storage_sha)
    reject("session verifier source drift", lambda: verify_session_store_receipt(
        {**session_report, "source_sha256": "0" * 64}, storage_sha))
    reject("session verifier incomplete", lambda: verify_session_store_receipt(
        {**session_report, "checks": 10}, storage_sha))

    identity_path = Path("fixture/release-identity-candidate.json")
    identity = require_identity_config(candidate_identity_fixture())
    reject("identity version drift", lambda: require_identity_config(
        {**identity, "android": {**identity["android"], "versionCode": 1}}))
    receipt_sha, apk_sha, hap_sha = "a" * 64, "b" * 64, "c" * 64
    android_report = {
        "schema": "lifeline-l26-android-apk-verification-v1",
        "status": "PASS_ANDROID_DEBUG_APK_L26",
        "identitySource": {"type": "EXPLICIT_CANDIDATE_CONFIG", "configPath": str(identity_path),
                           "identity": {**EXPECTED_ANDROID, "versionCode": "2"}},
        "package": {**EXPECTED_ANDROID, "versionCode": "2"},
        "apk": {"sha256": apk_sha}, "webBuildReceipt": {"sha256": receipt_sha},
    }
    verify_android_verifier_receipt(android_report, EXPECTED_ANDROID, identity_path, receipt_sha, apk_sha)
    reject("Android verifier receipt points at another Web receipt", lambda: verify_android_verifier_receipt(
        {**android_report, "webBuildReceipt": {"sha256": "d" * 64}},
        EXPECTED_ANDROID, identity_path, receipt_sha, apk_sha))
    harmony_report = {
        "schema": "lifeline-l26-harmony-hap-verification-v1",
        "status": "PASS_HARMONY_UNSIGNED_HAP_L26",
        "identitySource": {"type": "EXPLICIT_CANDIDATE_CONFIG", "configPath": str(identity_path),
                           "identity": EXPECTED_HARMONY},
        "app": EXPECTED_HARMONY,
        "hap": {"sha256": hap_sha}, "webBuildReceipt": {"sha256": receipt_sha},
    }
    verify_harmony_verifier_receipt(harmony_report, EXPECTED_HARMONY, identity_path, receipt_sha, hap_sha)
    reject("HAP verifier identity drift", lambda: verify_harmony_verifier_receipt(
        {**harmony_report, "app": {**EXPECTED_HARMONY, "versionName": "1.0.0"}},
        EXPECTED_HARMONY, identity_path, receipt_sha, hap_sha))

    dex = synthetic_dex()
    verify_storage_dex(dex, "fixture APK")
    reject("DEX lacks FileDescriptor.sync", lambda: verify_storage_dex(synthetic_dex(False), "mutant APK"))
    apk_buffer = io.BytesIO()
    with zipfile.ZipFile(apk_buffer, "w") as archive:
        archive.writestr("classes.dex", synthetic_dex(own_descriptor="Lfixture/OtherPlugin;"))
        archive.writestr("classes8.dex", dex)
    require(verify_apk_dex(apk_buffer.getvalue()) == "classes8.dex",
            "APK verifier did not select the DEX that defines LifelineStoragePlugin")
    duplicate_apk_buffer = io.BytesIO()
    with zipfile.ZipFile(duplicate_apk_buffer, "w") as archive:
        archive.writestr("classes.dex", dex)
        archive.writestr("classes8.dex", dex)
    reject("duplicate Storage plugin DEX", lambda: verify_apk_dex(duplicate_apk_buffer.getvalue()))
    module = {"app": dict(EXPECTED_HARMONY)}
    pack = {"summary": {"app": {"bundleName": EXPECTED_HARMONY["bundleName"],
                                  "version": {"code": 2, "name": "1.0.1"}}}}
    verify_harmony_package_metadata(module, pack, EXPECTED_HARMONY)
    reject("HAP module identity drift", lambda: verify_harmony_package_metadata(
        {"app": {**EXPECTED_HARMONY, "versionCode": 1}}, pack, EXPECTED_HARMONY))
    before = {Path("fixture-input"): sha256_bytes(b"before")}
    reject("input changed during verification", lambda: verify_input_stability_fixture(before, b"after"))

    print("PASS_L31A_STORAGE_PACKAGE_POLICY_SELF_TEST (source, session receipt, identity, DEX, HAP, and stability mutations rejected)")
    return 0


def verify_input_stability_fixture(before: dict[Path, str], after: bytes) -> None:
    require(sha256_bytes(after) == before[Path("fixture-input")], "Input changed during verification: fixture-input")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--apk", type=Path)
    parser.add_argument("--hap", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--session-verification", type=Path)
    parser.add_argument("--android-verification", type=Path)
    parser.add_argument("--harmony-verification", type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def verify_package(args: argparse.Namespace, root: Path) -> dict:
    require(all((args.apk, args.hap, args.receipt, args.session_verification,
                 args.android_verification, args.harmony_verification)),
            "APK, HAP, canonical Web receipt, session-store receipt, and both static-verifier receipts are required")
    apk_path = args.apk.resolve()
    hap_path = args.hap.resolve()
    receipt_path = args.receipt.resolve()
    session_report_path = args.session_verification.resolve()
    android_report_path = args.android_verification.resolve()
    harmony_report_path = args.harmony_verification.resolve()
    identity_path = (root / IDENTITY_CONFIG).resolve()
    inputs = [apk_path, hap_path, receipt_path, session_report_path,
              android_report_path, harmony_report_path, identity_path]
    for relative in REQUIRED_SOURCE_PATHS:
        source_path = (root / relative).resolve()
        if source_path not in inputs:
            inputs.append(source_path)
    input_bytes: dict[str, bytes] = {}
    for path in inputs:
        require(path.is_file(), f"Required input file not found: {path}")
        relative = path.relative_to(root).as_posix() if path.is_relative_to(root) else str(path)
        require(relative not in input_bytes, f"Duplicate input path: {relative}")
        input_bytes[relative] = path.read_bytes()
    digests = {path: sha256_bytes(path.read_bytes()) for path in inputs}
    source_payloads = {relative: input_bytes[(root / relative).resolve().relative_to(root).as_posix()]
                       for relative in REQUIRED_SOURCE_PATHS}
    receipt_bytes = input_bytes[receipt_path.relative_to(root).as_posix()]
    receipt = json.loads(receipt_bytes.decode("utf-8-sig"))
    source_hashes = verify_source_bindings(receipt, source_payloads)
    session_report = json.loads(input_bytes[session_report_path.relative_to(root).as_posix()].decode("utf-8-sig"))
    verify_session_store_receipt(session_report, source_hashes[REQUIRED_SOURCE_PATHS[0]])
    identity = require_identity_config(json.loads(input_bytes[identity_path.relative_to(root).as_posix()].decode("utf-8-sig")))
    apk_bytes = input_bytes[apk_path.relative_to(root).as_posix()]
    hap_bytes = input_bytes[hap_path.relative_to(root).as_posix()]
    apk_sha, hap_sha = sha256_bytes(apk_bytes), sha256_bytes(hap_bytes)
    receipt_sha = sha256_bytes(receipt_bytes)
    apk_dex_entry = verify_apk_dex(apk_bytes)
    verify_hap_metadata(hap_bytes, EXPECTED_HARMONY)
    android_report = json.loads(input_bytes[android_report_path.relative_to(root).as_posix()].decode("utf-8-sig"))
    harmony_report = json.loads(input_bytes[harmony_report_path.relative_to(root).as_posix()].decode("utf-8-sig"))
    verify_android_verifier_receipt(android_report, EXPECTED_ANDROID, identity_path, receipt_sha, apk_sha)
    verify_harmony_verifier_receipt(harmony_report, EXPECTED_HARMONY, identity_path, receipt_sha, hap_sha)
    verify_input_stability(digests)
    return {
        "schema": "lifeline-l31a-storage-package-policy-v1",
        "status": POLICY_STATUS,
        "scope": "Static package/source verification only; no build, device execution, release signing, installation, or store acceptance.",
        "identity": {"status": identity["status"], "android": EXPECTED_ANDROID, "harmony": EXPECTED_HARMONY},
        "canonicalWebReceipt": {"path": str(receipt_path), "sha256": receipt_sha},
        "sessionStoreVerification": {
            "path": str(session_report_path),
            "sha256": digests[session_report_path],
            "checks": session_report["checks"],
            "sourceSha256": session_report["source_sha256"].lower(),
        },
        "sourceHashes": source_hashes,
        "apk": {"path": str(apk_path), "sha256": apk_sha, "storageDexEntry": apk_dex_entry},
        "hap": {"path": str(hap_path), "sha256": hap_sha, "identityVerifiedIn": ["module.json", "pack.info"]},
        "staticVerifierReceipts": {
            "android": {"path": str(android_report_path), "sha256": digests[android_report_path]},
            "harmony": {"path": str(harmony_report_path), "sha256": digests[harmony_report_path]},
        },
        "inputStability": {"status": "PASS", "inputCount": len(digests)},
    }


def main() -> int:
    args = parse_args()
    if args.self_test:
        return run_self_test()
    root = Path(__file__).resolve().parents[2]
    result = verify_package(args, root)
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        output = args.output.resolve()
        require(not output.exists(), f"Refusing to overwrite existing policy receipt: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"L31-A storage package policy rejected: {error}", file=sys.stderr)
        raise SystemExit(1)
