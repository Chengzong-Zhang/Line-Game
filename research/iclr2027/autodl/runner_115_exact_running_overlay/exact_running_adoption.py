"""Fail-closed Runner 1.15 overlay for one exact running AutoDL instance.

This module is intentionally candidate-specific.  It only permits the v19
``require`` path to claim the already-running managed instance named below.
It never calls create, power_on, power_off, reap, or release.
"""

from __future__ import annotations

from functools import wraps
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


RUNNER_VERSION = "1.15.0"
EXACT_INSTANCE_UUID = "pro-788096a9e3b2"
MANAGED_INSTANCE_PREFIX = "ar-ld-"
MAX_PRICE_MILLIYUAN_PER_HOUR = 2880
EXPECTED_NAMESPACE = "direct"


class ExactRunningAdoptionError(RuntimeError):
    """The exact-running adoption contract was not proved."""


def _fail(detail: str) -> None:
    raise ExactRunningAdoptionError(f"exact-running adoption refused: {detail}")


def _state_value(value: object) -> str:
    return str(getattr(value, "value", value)).lower()


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        _fail(f"{field} is absent")
    return value


def _required_int(value: object, field: str, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        _fail(f"{field} is absent or invalid")
    return value


def _one_exact_profile(
    profiles: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    if len(profiles) != 1:
        _fail("the require job must resolve to exactly one instance profile")
    profile = dict(profiles[0])
    _required_text(profile.get("gpu_spec_uuid"), "profile.gpu_spec_uuid")
    _required_text(profile.get("data_center"), "profile.data_center")
    _required_int(profile.get("gpu_num"), "profile.gpu_num", minimum=1)
    _required_text(profile.get("image_uuid"), "profile.image_uuid")
    _required_int(profile.get("cuda_v_from"), "profile.cuda_v_from")
    _required_int(
        profile.get("expand_system_disk_by_gb"),
        "profile.expand_system_disk_by_gb",
    )
    return profile


def _verify_platform_record(instance: object, profile: Mapping[str, object]) -> str:
    if getattr(instance, "uuid", None) != EXACT_INSTANCE_UUID:
        _fail("platform UUID changed during exact selection")
    name = _required_text(getattr(instance, "name", None), "platform.name")
    if not name.startswith(MANAGED_INSTANCE_PREFIX):
        _fail("platform name is not managed by the direct runner")
    if _state_value(getattr(instance, "status", None)) != "running":
        _fail("platform inventory does not report running")
    if getattr(instance, "gpu_spec_uuid", None) != profile["gpu_spec_uuid"]:
        _fail("platform GPU does not match the sole allowed profile")
    if getattr(instance, "req_gpu_amount", None) != profile["gpu_num"]:
        _fail("platform GPU count does not match the sole allowed profile")
    if getattr(instance, "region_sign", None) != profile["data_center"]:
        _fail("platform region does not match the sole allowed profile")
    return name


def _verify_registry_record(
    record: object,
    *,
    instance_name: str,
    profile: Mapping[str, object],
) -> int:
    if getattr(record, "instance_uuid", None) != EXACT_INSTANCE_UUID:
        _fail("registry UUID is absent or inconsistent")
    if getattr(record, "namespace", None) != EXPECTED_NAMESPACE:
        _fail("registry namespace is not direct")
    if getattr(record, "instance_name", None) != instance_name:
        _fail("platform and registry managed names differ")
    if _state_value(getattr(record, "state", None)) not in {"stopped", "ready"}:
        _fail("registry generation is not STOPPED or READY")

    for field in ("gpu_spec_uuid", "data_center", "gpu_num", "image_uuid"):
        observed = getattr(record, field, None)
        expected = profile[field]
        if observed is None or observed != expected:
            _fail(f"registry {field} does not exactly match the job profile")

    observed_cuda = _required_int(
        getattr(record, "cuda_v_from", None), "registry.cuda_v_from"
    )
    if observed_cuda < int(profile["cuda_v_from"]):
        _fail("registry CUDA capability is below the job profile")
    observed_disk = _required_int(
        getattr(record, "expand_system_disk_by_gb", None),
        "registry.expand_system_disk_by_gb",
    )
    if observed_disk < int(profile["expand_system_disk_by_gb"]):
        _fail("registry system disk is below the job profile")
    return _required_int(getattr(record, "generation", None), "registry.generation")


def _verify_claim(
    record: object,
    *,
    instance_name: str,
    owner_job_id: str,
    expected_generation: int,
) -> None:
    if getattr(record, "instance_uuid", None) != EXACT_INSTANCE_UUID:
        _fail("claim returned another UUID")
    if getattr(record, "namespace", None) != EXPECTED_NAMESPACE:
        _fail("claim returned another namespace")
    if getattr(record, "instance_name", None) != instance_name:
        _fail("claim returned another managed name")
    if getattr(record, "owner_job_id", None) != owner_job_id:
        _fail("claim owner differs from the exact job")
    if getattr(record, "generation", None) != expected_generation:
        _fail("claim did not advance exactly one registry generation")
    if _state_value(getattr(record, "state", None)) != "claiming":
        _fail("claim is not generation-fenced in CLAIMING state")


def exact_find_and_claim_ready(
    self: Any,
    *,
    owner_job_id: str,
    owner_state_dir: Path,
    profiles: Sequence[Mapping[str, object]],
    hard_deadline_at: int,
    preferred_instance_uuid: str | None = None,
    target_environment_id: str | None = None,
    target_environment_profile: Mapping[str, object] | None = None,
) -> object:
    """Claim only the configured running UUID, or raise before generic fallback."""

    del target_environment_id, target_environment_profile
    if self.namespace != EXPECTED_NAMESPACE:
        _fail("session manager namespace is not direct")
    if preferred_instance_uuid != EXACT_INSTANCE_UUID:
        _fail("preferred UUID is not the authorized exact UUID")
    profile = _one_exact_profile(profiles)

    # Runner 1.15 exposes inventory metadata only through the read-only list
    # endpoint.  Filter immediately by UUID; no status/action call is made for
    # any other returned instance.
    instances = self.client.list_all_instances()
    exact_matches = [
        item for item in instances if getattr(item, "uuid", None) == EXACT_INSTANCE_UUID
    ]
    if len(exact_matches) != 1:
        _fail("platform inventory does not contain one unique exact UUID")
    instance = exact_matches[0]
    instance_name = _verify_platform_record(instance, profile)

    registry_before = self.registry.get(EXACT_INSTANCE_UUID)
    if registry_before is None:
        _fail("exact UUID is absent from the registry")
    previous_generation = _verify_registry_record(
        registry_before,
        instance_name=instance_name,
        profile=profile,
    )

    provider_status = self.client.get_instance_status(
        EXACT_INSTANCE_UUID,
        lease_key=instance_name,
    )
    if _state_value(provider_status) != "running":
        _fail("exact provider status is not running")

    snapshot = self.client.get_instance_snapshot(EXACT_INSTANCE_UUID)
    price = getattr(snapshot, "payg_price", None)
    if type(price) is not int:
        _fail("snapshot payg_price is absent")
    if price > MAX_PRICE_MILLIYUAN_PER_HOUR:
        _fail("snapshot payg_price exceeds 2880 milliyuan/hour")
    snapshot_region = getattr(snapshot, "region_sign", None)
    if snapshot_region is not None and snapshot_region != profile["data_center"]:
        _fail("snapshot region conflicts with the exact platform record")

    claimed = self.registry.claim(
        instance_uuid=EXACT_INSTANCE_UUID,
        namespace=EXPECTED_NAMESPACE,
        instance_name=instance_name,
        owner_job_id=owner_job_id,
        owner_state_dir=owner_state_dir,
        profile=profile,
        hard_deadline_at=hard_deadline_at,
        allow_new=False,
    )
    expected_generation = previous_generation + 1
    _verify_claim(
        claimed,
        instance_name=instance_name,
        owner_job_id=owner_job_id,
        expected_generation=expected_generation,
    )
    current = self.registry.get(EXACT_INSTANCE_UUID)
    if current is None:
        _fail("claimed generation disappeared from the registry")
    _verify_claim(
        current,
        instance_name=instance_name,
        owner_job_id=owner_job_id,
        expected_generation=expected_generation,
    )
    return current


def _guarded_provision_and_launch(
    original: Callable[..., object],
) -> Callable[..., object]:
    @wraps(original)
    def guarded(self: Any, spec: Any, candidates: Any) -> object:
        if getattr(spec, "instance_reuse", None) != "require":
            _fail("overlay requires instance_reuse='require'")
        if getattr(spec, "preferred_instance_uuid", None) != EXACT_INSTANCE_UUID:
            _fail("job does not require the authorized exact UUID")
        if getattr(self.policy, "max_price_milliyuan_per_hour", None) != 2880:
            _fail("policy max_price_milliyuan_per_hour is not exactly 2880")
        if getattr(self.policy, "max_hourly_spend_milliyuan", None) != 2880:
            _fail("policy max_hourly_spend_milliyuan is not exactly 2880")
        if getattr(self.policy, "auto_release", None) is not False:
            _fail("policy auto_release must remain false")
        return original(self, spec, candidates)

    return guarded


def install() -> None:
    """Install the in-process patch without changing Runner's installation."""

    import autodl_runner_direct
    from autodl_runner_direct.controller import ProductController
    from autodl_runner_direct.session_manager import SessionManager

    if getattr(autodl_runner_direct, "__version__", None) != RUNNER_VERSION:
        _fail("overlay only supports AutoDL Runner 1.15.0")
    if getattr(SessionManager, "_v19_exact_running_overlay", False):
        if not getattr(ProductController, "_v19_exact_running_overlay", False):
            _fail("overlay is only partially installed")
        return

    original_find = SessionManager.find_and_claim_ready
    original_provision = ProductController._provision_and_launch
    SessionManager._v19_exact_running_original = original_find
    ProductController._v19_exact_running_original = original_provision
    SessionManager.find_and_claim_ready = exact_find_and_claim_ready
    ProductController._provision_and_launch = _guarded_provision_and_launch(
        original_provision
    )
    SessionManager._v19_exact_running_overlay = True
    ProductController._v19_exact_running_overlay = True


__all__ = [
    "EXACT_INSTANCE_UUID",
    "ExactRunningAdoptionError",
    "MAX_PRICE_MILLIYUAN_PER_HOUR",
    "exact_find_and_claim_ready",
    "install",
]
