from datetime import datetime, timedelta

from sqlalchemy import text

from backend import database, models
from backend.services import fleet_service, route_planning_service


def _reset_core_tables(db):
    db.query(models.RoutePlan).delete()
    db.query(models.Shipment).delete()
    db.query(models.Driver).delete()
    db.commit()


def test_assign_route_plan_by_plate_prefers_standardized_driver_account():
    db = database.SessionLocal()
    try:
        route_planning_service.ensure_route_plans_schema(db)
        _reset_core_tables(db)

        # Same truck plate exists on both a legacy and a standardized account.
        # Assignment by plate should pick the standardized fleet account so the
        # intended mobile driver user can see the route.
        legacy = models.Driver(
            driver_id="D004",
            name="Legacy Driver",
            username="legacydriver",
            password_hash="x",
            role="Driver",
            active=True,
            truck_plate="BC55NIK",
            last_login=datetime.utcnow(),
        )
        standardized = models.Driver(
            driver_id="DRV003",
            name="Standardized Driver",
            username="standarddriver",
            password_hash="x",
            role="Driver",
            active=True,
            truck_plate="BC55NIK",
            last_login=datetime.utcnow() - timedelta(days=2),
        )
        db.add_all([legacy, standardized])

        shipment = models.Shipment(awb="TEST-AWB-1", status="in depozitul curierului")
        db.add(shipment)

        plan = models.RoutePlan(
            plan_date="2026-03-11",
            county="Bacau",
            route_index=1,
            name="Bacau",
            status=route_planning_service.STATUS_APPROVED,
            awbs=["TEST-AWB-1"],
            awb_count=1,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(plan)
        db.commit()
        db.refresh(plan)

        out = route_planning_service.assign_route_plan(
            db,
            plan=plan,
            vehicle_plate="BC55NIK",
            assigned_by_user_id="D001",
        )
        db.commit()
        db.refresh(plan)
        db.refresh(shipment)

        assert out["assigned_driver_id"] == "DRV003"
        assert plan.assigned_driver_id == "DRV003"
        assert shipment.driver_id == "DRV003"
    finally:
        db.close()


def test_generate_daily_route_plans_tolerates_legacy_non_numeric_route_index():
    db = database.SessionLocal()
    try:
        route_planning_service.ensure_route_plans_schema(db)
        _reset_core_tables(db)

        driver = models.Driver(
            driver_id="DRV700",
            name="Planner Driver",
            username="plannerdriver",
            password_hash="x",
            role="Driver",
            active=True,
            truck_plate="BC99ZZZ",
            last_login=datetime.utcnow(),
        )
        shipment = models.Shipment(
            awb="TEST-AWB-LEGACY-ROUTE-INDEX",
            status="in depozitul curierului",
            recipient_name="Recipient",
            locality="Bacau",
            delivery_address="Bacau, Str. Test 1",
            weight=10.0,
        )
        db.add_all([driver, shipment])
        db.commit()

        # Simulate a legacy/dirty row where route_index is non-numeric.
        db.execute(
            text(
                """
                INSERT INTO route_plans (
                    plan_date, county, route_index, name, status, created_at, updated_at, awbs
                ) VALUES (
                    :plan_date, :county, :route_index, :name, :status, :created_at, :updated_at, :awbs
                )
                """
            ),
            {
                "plan_date": "2026-03-11",
                "county": "Bacau",
                "route_index": "A",
                "name": "Legacy Bacau",
                "status": route_planning_service.STATUS_DRAFT,
                "created_at": datetime.utcnow(),
                "updated_at": datetime.utcnow(),
                "awbs": '["TEST-AWB-OLD"]',
            },
        )
        db.commit()

        summary = route_planning_service.generate_daily_route_plans(
            db,
            plan_date="2026-03-11",
            generated_by_user_id="D001",
            trigger="manual",
        )

        assert summary["date"] == "2026-03-11"
        assert isinstance(summary.get("plans"), list)
        assert any(str(p.get("county") or "").strip().lower() == "bacau" for p in summary["plans"])
    finally:
        _reset_core_tables(db)
        db.close()


def test_generate_daily_route_plans_survives_shipments_schema_migration_error(monkeypatch):
    db = database.SessionLocal()
    try:
        route_planning_service.ensure_route_plans_schema(db)
        _reset_core_tables(db)

        db.add(
            models.Shipment(
                awb="TEST-AWB-SCHEMA-FALLBACK",
                status="in depozitul curierului",
                recipient_name="Recipient",
                locality="Bacau",
                delivery_address="Bacau, Str. Test 2",
                weight=7.0,
            )
        )
        db.commit()

        def _raise_schema_error(_db):
            raise PermissionError("ALTER TABLE not allowed")

        monkeypatch.setattr(route_planning_service.shipments_service, "ensure_shipments_schema", _raise_schema_error)

        summary = route_planning_service.generate_daily_route_plans(
            db,
            plan_date="2026-03-11",
            generated_by_user_id="D001",
            trigger="manual",
        )

        assert summary["date"] == "2026-03-11"
        assert int(summary.get("allocated_awbs") or 0) >= 1
        assert any(str(p.get("county") or "").strip().lower() == "bacau" for p in (summary.get("plans") or []))
    finally:
        _reset_core_tables(db)
        db.close()


def test_sync_vehicles_from_drivers_preserves_driver_id_casing_for_fk():
    db = database.SessionLocal()
    try:
        route_planning_service.ensure_route_plans_schema(db)
        fleet_service.ensure_fleet_schema(db)
        _reset_core_tables(db)
        db.query(models.FleetVehicle).delete()
        db.commit()

        driver = models.Driver(
            driver_id="mariusborc",
            name="Marius Borc",
            username="mariusborc",
            password_hash="x",
            role="Driver",
            active=True,
            truck_plate="BC76ARI",
            last_login=datetime.utcnow(),
        )
        db.add(driver)
        db.commit()

        changed = fleet_service.sync_vehicles_from_drivers(db)
        assert int(changed or 0) >= 1

        row = db.query(models.FleetVehicle).filter(models.FleetVehicle.plate == "BC76ARI").first()
        assert row is not None
        assert row.assigned_driver_id == "mariusborc"
    finally:
        db.query(models.FleetVehicle).delete()
        _reset_core_tables(db)
        db.close()


def test_assign_route_plan_by_driver_id_case_insensitive_keeps_real_driver_id():
    db = database.SessionLocal()
    try:
        route_planning_service.ensure_route_plans_schema(db)
        _reset_core_tables(db)

        driver = models.Driver(
            driver_id="mariusborc",
            name="Marius Borc",
            username="mariusborc2",
            password_hash="x",
            role="Driver",
            active=True,
            truck_plate="BC76ARI",
            last_login=datetime.utcnow(),
        )
        shipment = models.Shipment(awb="TEST-AWB-CASE-ID", status="in depozitul curierului")
        plan = models.RoutePlan(
            plan_date="2026-03-11",
            county="Bacau",
            route_index=1,
            name="Bacau",
            status=route_planning_service.STATUS_APPROVED,
            awbs=["TEST-AWB-CASE-ID"],
            awb_count=1,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add_all([driver, shipment, plan])
        db.commit()
        db.refresh(plan)

        out = route_planning_service.assign_route_plan(
            db,
            plan=plan,
            vehicle_plate="BC76ARI",
            assigned_by_user_id="D001",
            assigned_driver_id="MARIUSBORC",
        )
        db.commit()
        db.refresh(plan)
        db.refresh(shipment)

        assert out["assigned_driver_id"] == "mariusborc"
        assert plan.assigned_driver_id == "mariusborc"
        assert shipment.driver_id == "mariusborc"
    finally:
        _reset_core_tables(db)
        db.close()


def test_generate_daily_route_plans_keeps_refused_in_waiting_list():
    db = database.SessionLocal()
    try:
        route_planning_service.ensure_route_plans_schema(db)
        _reset_core_tables(db)

        db.add_all([
            models.Shipment(
                awb="TEST-AWB-REFUSED-WAITING",
                status="Refuzare colet",
                recipient_name="Recipient Refused",
                locality="Bacau",
                delivery_address="Bacau, Str. A",
                weight=5.0,
            ),
            models.Shipment(
                awb="TEST-AWB-OUT-DELIVERY",
                status="Out for delivery",
                recipient_name="Recipient Out",
                locality="Bacau",
                delivery_address="Bacau, Str. B",
                weight=4.0,
            ),
        ])
        db.commit()

        summary = route_planning_service.generate_daily_route_plans(
            db,
            plan_date="2026-03-11",
            generated_by_user_id="D001",
            trigger="manual",
        )

        assert int(summary.get("allocated_awbs") or 0) >= 1
        assert int(summary.get("refused_waiting") or 0) == 1
        refused_list = list(summary.get("refused_waiting_awbs") or [])
        awbs = {str(item.get("awb") or "").strip().upper() for item in refused_list}
        assert "TEST-AWB-REFUSED-WAITING" in awbs
        assert "TEST-AWB-OUT-DELIVERY" not in awbs
    finally:
        _reset_core_tables(db)
        db.close()
