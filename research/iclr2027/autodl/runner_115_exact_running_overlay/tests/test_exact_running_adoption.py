from __future__ import annotations

import sys
import unittest
from dataclasses import dataclass, replace
from pathlib import Path
from types import SimpleNamespace


OVERLAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OVERLAY_ROOT))

from exact_running_adoption import (  # noqa: E402
    EXACT_INSTANCE_UUID,
    ExactRunningAdoptionError,
    _guarded_provision_and_launch,
    exact_find_and_claim_ready,
    install,
)


@dataclass(frozen=True)
class FakeRecord:
    instance_uuid: str = EXACT_INSTANCE_UUID
    namespace: str = "direct"
    instance_name: str = "ar-ld-prior-formal-1"
    state: str = "stopped"
    owner_job_id: str | None = None
    generation: int = 7
    gpu_spec_uuid: str | None = "5090-p"
    data_center: str | None = "beijingDC2"
    gpu_num: int | None = 1
    image_uuid: str | None = "base-image-ec1e9vdbd3"
    cuda_v_from: int | None = 128
    expand_system_disk_by_gb: int | None = 0


PROFILE = {
    "gpu_spec_uuid": "5090-p",
    "data_center": "beijingDC2",
    "gpu_num": 1,
    "image_uuid": "base-image-ec1e9vdbd3",
    "cuda_v_from": 128,
    "expand_system_disk_by_gb": 0,
}


class FakeClient:
    def __init__(self) -> None:
        self.actions: list[tuple[object, ...]] = []
        self.target = SimpleNamespace(
            uuid=EXACT_INSTANCE_UUID,
            name="ar-ld-prior-formal-1",
            status="running",
            gpu_spec_uuid="5090-p",
            req_gpu_amount=1,
            region_sign="beijingDC2",
        )
        self.unrelated = SimpleNamespace(
            uuid="pro-unrelated",
            name="ar-ld-unrelated-1",
            status="running",
            gpu_spec_uuid="a100",
            req_gpu_amount=1,
            region_sign="westDC3",
        )
        self.provider_status = "running"
        self.price: int | None = 2880

    def list_all_instances(self):
        self.actions.append(("list_all_instances",))
        return [self.unrelated, self.target]

    def get_instance_status(self, instance_uuid: str, *, lease_key: str | None = None):
        self.actions.append(("get_instance_status", instance_uuid, lease_key))
        return self.provider_status

    def get_instance_snapshot(self, instance_uuid: str):
        self.actions.append(("get_instance_snapshot", instance_uuid))
        return SimpleNamespace(
            payg_price=self.price,
            region_sign="beijingDC2",
        )

    def create_instance(self, *args, **kwargs):  # pragma: no cover - safety sentinel
        raise AssertionError("create must be unreachable")

    power_on = create_instance
    power_off = create_instance
    release = create_instance


class FakeRegistry:
    def __init__(self, record: FakeRecord | None = None) -> None:
        self.record = record or FakeRecord()
        self.calls: list[tuple[object, ...]] = []
        self.claimed = False
        self.generation_delta = 1

    def get(self, instance_uuid: str):
        self.calls.append(("get", instance_uuid))
        return self.record

    def list(self, *args, **kwargs):  # pragma: no cover - safety sentinel
        raise AssertionError("generic registry scan must be unreachable")

    def claim(self, **kwargs):
        self.calls.append(("claim", kwargs.copy()))
        if kwargs.get("instance_uuid") != EXACT_INSTANCE_UUID:
            raise AssertionError("claim touched another UUID")
        if kwargs.get("allow_new") is not False:
            raise AssertionError("claim must not import a new registry row")
        self.claimed = True
        self.record = replace(
            self.record,
            state="claiming",
            owner_job_id=str(kwargs["owner_job_id"]),
            generation=self.record.generation + self.generation_delta,
        )
        return self.record


def manager(client: FakeClient, registry: FakeRegistry):
    return SimpleNamespace(namespace="direct", client=client, registry=registry)


def adopt(client: FakeClient, registry: FakeRegistry):
    return exact_find_and_claim_ready(
        manager(client, registry),
        owner_job_id="ld-lifeline-d18-v3-form-v19",
        owner_state_dir=Path("C:/Users/zcz/.autodl-runner-direct"),
        profiles=[PROFILE],
        hard_deadline_at=4_000_000_000,
        preferred_instance_uuid=EXACT_INSTANCE_UUID,
    )


class ExactRunningAdoptionTests(unittest.TestCase):
    def test_success_claims_only_exact_uuid_with_generation_fence(self) -> None:
        client = FakeClient()
        registry = FakeRegistry()
        claimed = adopt(client, registry)
        self.assertEqual(claimed.generation, 8)
        self.assertEqual(claimed.state, "claiming")
        self.assertTrue(registry.claimed)
        self.assertEqual(
            client.actions,
            [
                ("list_all_instances",),
                (
                    "get_instance_status",
                    EXACT_INSTANCE_UUID,
                    "ar-ld-prior-formal-1",
                ),
                ("get_instance_snapshot", EXACT_INSTANCE_UUID),
            ],
        )
        claim = next(row for row in registry.calls if row[0] == "claim")
        self.assertIs(claim[1]["allow_new"], False)
        self.assertEqual(claim[1]["instance_uuid"], EXACT_INSTANCE_UUID)

    def test_unrelated_instances_are_never_queried_or_claimed(self) -> None:
        client = FakeClient()
        registry = FakeRegistry()
        adopt(client, registry)
        flattened = repr(client.actions + registry.calls)
        self.assertNotIn("pro-unrelated", flattened)

    def test_every_platform_and_price_mismatch_fails_before_claim(self) -> None:
        mutations = {
            "uuid_absent": lambda c: setattr(c.target, "uuid", "pro-other"),
            "unmanaged_name": lambda c: setattr(c.target, "name", "manual-name"),
            "inventory_stopped": lambda c: setattr(c.target, "status", "stopped"),
            "gpu": lambda c: setattr(c.target, "gpu_spec_uuid", "a100"),
            "count": lambda c: setattr(c.target, "req_gpu_amount", 2),
            "region": lambda c: setattr(c.target, "region_sign", "westDC3"),
            "provider_stopped": lambda c: setattr(c, "provider_status", "stopped"),
            "price_absent": lambda c: setattr(c, "price", None),
            "price_high": lambda c: setattr(c, "price", 2881),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                client = FakeClient()
                registry = FakeRegistry()
                mutate(client)
                with self.assertRaises(ExactRunningAdoptionError):
                    adopt(client, registry)
                self.assertFalse(registry.claimed)

    def test_every_registry_mismatch_fails_before_claim(self) -> None:
        records = {
            "namespace": replace(FakeRecord(), namespace="tencent"),
            "name": replace(FakeRecord(), instance_name="ar-ld-other-1"),
            "busy": replace(FakeRecord(), state="busy"),
            "gpu_missing": replace(FakeRecord(), gpu_spec_uuid=None),
            "gpu": replace(FakeRecord(), gpu_spec_uuid="a100"),
            "region": replace(FakeRecord(), data_center="westDC3"),
            "count": replace(FakeRecord(), gpu_num=2),
            "image": replace(FakeRecord(), image_uuid="other-image"),
            "cuda_missing": replace(FakeRecord(), cuda_v_from=None),
            "cuda_low": replace(FakeRecord(), cuda_v_from=127),
            "disk_missing": replace(FakeRecord(), expand_system_disk_by_gb=None),
        }
        for name, record in records.items():
            with self.subTest(name=name):
                client = FakeClient()
                registry = FakeRegistry(record)
                with self.assertRaises(ExactRunningAdoptionError):
                    adopt(client, registry)
                self.assertFalse(registry.claimed)

    def test_generation_race_fails_closed(self) -> None:
        client = FakeClient()
        registry = FakeRegistry()
        registry.generation_delta = 2
        with self.assertRaisesRegex(ExactRunningAdoptionError, "generation"):
            adopt(client, registry)

    def test_require_and_policy_guard_has_no_fallback(self) -> None:
        calls: list[str] = []

        def original(_self, _spec, _candidates):
            calls.append("original")
            return "ok"

        guarded = _guarded_provision_and_launch(original)
        controller = SimpleNamespace(
            policy=SimpleNamespace(
                max_price_milliyuan_per_hour=2880,
                max_hourly_spend_milliyuan=2880,
                auto_release=False,
            )
        )
        exact = SimpleNamespace(
            instance_reuse="require",
            preferred_instance_uuid=EXACT_INSTANCE_UUID,
        )
        self.assertEqual(guarded(controller, exact, []), "ok")
        self.assertEqual(calls, ["original"])

        for bad in (
            SimpleNamespace(
                instance_reuse="prefer",
                preferred_instance_uuid=EXACT_INSTANCE_UUID,
            ),
            SimpleNamespace(instance_reuse="require", preferred_instance_uuid="pro-other"),
        ):
            with self.assertRaises(ExactRunningAdoptionError):
                guarded(controller, bad, [])
        self.assertEqual(calls, ["original"])

    def test_install_is_runner_115_process_local_and_idempotent(self) -> None:
        install()
        install()
        from autodl_runner_direct.controller import ProductController
        from autodl_runner_direct.session_manager import SessionManager

        self.assertTrue(SessionManager._v19_exact_running_overlay)
        self.assertTrue(ProductController._v19_exact_running_overlay)
        self.assertIs(SessionManager.find_and_claim_ready, exact_find_and_claim_ready)


if __name__ == "__main__":
    unittest.main(verbosity=2)
