from datetime import datetime, timedelta

from backend import database, models
from backend.services import route_planning_service


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
