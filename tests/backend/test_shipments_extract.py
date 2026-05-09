from backend.services import geocoding_service
from backend.services import shipments_service
from backend.services import route_planning_service


class _ShipmentLike:
    def __init__(
        self,
        content_description="",
        raw_data=None,
        awb="",
        delivery_address="",
        locality="",
        recipient_location=None,
        recipient_pin=None,
        geocode_query="",
    ):
        self.awb = awb
        self.content_description = content_description
        self.delivery_address = delivery_address
        self.locality = locality
        self.recipient_location = recipient_location or {}
        self.recipient_pin = recipient_pin or {}
        self.raw_data = raw_data or {}
        self.geocode_query = geocode_query


def test_build_upsert_payload_extracts_cost_content_dims_and_carrier():
    ship_data = {
        "awb": "102R1842063",
        "carrier": {"carrierId": "LOCALFLNBC01", "carrierName": "REGIO BACAU 01"},
        "processingStatus": "ROUTED",
        "salesChannel": "ONLINE",
        "deliveryMethod": "Standard Delivery",
        "type": "FORWARD_AND_BACK",
        "packingList": "102_01880900 / 102R1842063",
        "shippingInstruction": "REF Retur deseu la GreenWee Buzau",
        "paymentType": "CASH",
        "carrierShippingCost": 75,
        "estimatedShippingCost": 75,
        "declaredValue": 2372.51,
        "oversized": True,
        "insurance": True,
        "openPackage": True,
        "priority": True,
        "length": 76.5,
        "width": 64,
        "height": 193,
        "brutWeight": 72,
        "volumetricWeight": 157.49,
        "createdDate": "2026-02-15T18:16:00Z",
        "awbStatusDate": "2026-02-15T18:16:16Z",
        "additionalServices": {"cashOnDelivery": 0},
        "recipientLocation": {
            "name": "MADALINA SILVIA MUNTEANU",
            "country": "Romania",
            "county": "Vrancea",
            "locality": "Focsani",
            "addressText": "B-DUL BRAILEI, NR. 148 ,AP.4 ,ETJ. 1",
            "phoneNumber": "0764868804",
            "email": "ANK_PAUL27@YAHOO.COM",
        },
        "senderLocation": {
            "name": "Depozit Flanco Pro Packing (Online&Magazine)",
            "county": "Ilfov",
            "locality": "Dragomiresti-Deal",
            "addressText": "CTP Business Park, cladirea C1",
        },
    }

    payload = shipments_service.build_upsert_payload(ship_data, store_raw_data=False)

    assert payload["awb"] == "102R1842063"
    assert payload["shipping_cost"] == 75.0
    assert payload["estimated_shipping_cost"] == 75.0
    assert payload["currency"] == "RON"
    assert payload["content_description"] == "102_01880900 / 102R1842063"
    assert payload["dimensions"] == "76.5x64x193 cm"

    # Carrier/courier mapping should preserve both code and name.
    courier = payload.get("courier_data") or {}
    assert isinstance(courier, dict)
    assert courier.get("carrierId") == "LOCALFLNBC01"
    assert courier.get("carrierName") == "REGIO BACAU 01"
    assert courier.get("courierId") == "LOCALFLNBC01"
    assert courier.get("courierName") == "REGIO BACAU 01"

    # Ensure ops flags are promoted into additional_services.
    services = payload.get("additional_services") or {}
    assert services.get("openPackage") is True
    assert services.get("priority") is True
    assert services.get("insurance") is True
    assert services.get("oversized") is True


def test_extract_content_prefers_all_itemized_products_over_single_direct_value():
    ship_data = {
        "contentDescription": "Frigider",
        "products": [
            {"quantity": 1, "name": "Frigider"},
            {"quantity": 2, "name": "Cuptor microunde"},
        ],
    }

    assert shipments_service._extract_content_description(ship_data) == "Frigider; 2x Cuptor microunde"


def test_route_plan_content_prefers_raw_itemized_products_over_stored_single_value():
    shipment = _ShipmentLike(
        content_description="Frigider",
        raw_data={
            "items": [
                {"name": "Frigider"},
                {"name": "Masina de spalat"},
            ]
        },
    )

    assert route_planning_service._shipment_content_description(shipment) == "Frigider; Masina de spalat"


def test_geocode_query_ignores_placeholder_postal_code_zeroes():
    shipment = _ShipmentLike(
        awb="TPOSTAL00001",
        delivery_address="00000, Strada Mioritei nr. 12",
        locality="Bacau",
        recipient_location={"county": "Bacau"},
    )

    assert geocoding_service.build_geocode_query_for_shipment(shipment) == "Strada Mioritei nr. 12, Bacau, Romania"
    assert geocoding_service._shipment_has_precise_address(shipment) is True


def test_geocode_query_builds_address_from_structured_street_when_postal_is_placeholder():
    shipment = _ShipmentLike(
        awb="TPOSTAL00004",
        delivery_address="00000",
        locality="Bacau",
        recipient_location={
            "county": "Bacau",
            "streetName": "Strada Energiei",
            "streetNumber": "7",
        },
    )

    assert geocoding_service.build_geocode_query_for_shipment(shipment) == "Strada Energiei, nr. 7, Bacau, Romania"
    assert geocoding_service._shipment_has_precise_address(shipment) is True


def test_geocode_query_strips_commercial_poi_prefix_before_street():
    shipment = _ShipmentLike(
        awb="TPOI00001",
        delivery_address="Complex Supernova Bacau, Strada Milcov 2-4, Bacau",
        locality="Bacau",
        recipient_location={"county": "Bacau"},
    )

    assert geocoding_service.build_geocode_query_for_shipment(shipment) == "Strada Milcov 2-4, Bacau, Romania"


def test_geocoder_tries_provider_friendly_romanian_address_variants(monkeypatch):
    calls = []

    def fake_nominatim(_client, query, *, timeout_s, expected_locality, expected_county):
        calls.append(query)
        if query != "Strada Narciselor, 17A, Bacau, Romania":
            return None
        return {
            "lat": 46.5384858,
            "lon": 26.9095203,
            "display_name": "Strada Narciselor, Bacau, Romania",
            "provider": "nominatim",
            "matched_locality": True,
            "matched_county": True,
        }

    monkeypatch.setattr(geocoding_service, "_nominatim_geocode", fake_nominatim)

    result = geocoding_service._geocode_with_providers(
        object(),
        "Str. Narciselor, Nr. 17A, Bacau, Romania",
        timeout_s=1,
        expected_locality="bacau",
        expected_county="bacau",
        providers=["nominatim"],
    )

    assert result is not None
    assert calls[:2] == [
        "Str. Narciselor, Nr. 17A, Bacau, Romania",
        "Strada Narciselor, 17A, Bacau, Romania",
    ]


def test_geocode_key_is_versioned_to_invalidate_stale_saved_coordinates():
    query = "Strada Narciselor, Bacau, Romania"
    legacy_key = geocoding_service.hashlib.sha1(
        geocoding_service._normalize_for_key(query).encode("utf-8")
    ).hexdigest()

    assert geocoding_service.build_geocode_key(query) != legacy_key


def test_placeholder_postal_code_alone_is_not_precise_address_and_fallback_spreads_by_awb():
    first = _ShipmentLike(
        awb="TPOSTAL00002",
        delivery_address="00000",
        locality="Bacau",
        recipient_location={"county": "Bacau"},
    )
    second = _ShipmentLike(
        awb="TPOSTAL00003",
        delivery_address="00000",
        locality="Bacau",
        recipient_location={"county": "Bacau"},
    )

    assert geocoding_service.build_geocode_query_for_shipment(first) == "Bacau, Romania"
    assert geocoding_service._shipment_has_precise_address(first) is False

    localities = {"bacau": (46.571, 26.92)}
    first_lat, first_lon, first_source = geocoding_service.fallback_coords_for_shipment(
        first,
        locality_centroids=localities,
    )
    second_lat, second_lon, second_source = geocoding_service.fallback_coords_for_shipment(
        second,
        locality_centroids=localities,
    )

    assert first_source == "fallback-locality-hash"
    assert second_source == "fallback-locality-hash"
    assert (first_lat, first_lon) != (second_lat, second_lon)


def test_geocoder_does_not_relax_locality_after_strict_miss(monkeypatch):
    calls = []

    def fake_google(_client, _query, *, timeout_s, api_key, expected_locality, expected_county):
        calls.append((expected_locality, expected_county))
        if expected_locality or expected_county:
            return None
        return {
            "lat": 44.4268,
            "lon": 26.1025,
            "display_name": "Wrong relaxed result",
            "provider": "google_geocoding",
        }

    monkeypatch.setattr(geocoding_service, "_google_geocode", fake_google)

    result = geocoding_service._geocode_with_providers(
        object(),
        "Strada Test 1, Bacau, Romania",
        timeout_s=1,
        expected_locality="bacau",
        expected_county="bacau",
        providers=["google"],
        google_api_key="dummy",
    )

    assert result is None
    assert calls == [("bacau", "bacau")]


def test_nominatim_locality_match_prefers_city_over_county_display_name():
    wrong_county_match = {
        "lat": "46.7435347",
        "lon": "26.8411520",
        "type": "residential",
        "display_name": "Strada Narciselor, Galbeni, Filipesti, Bacau, Romania",
        "address": {"road": "Strada Narciselor", "village": "Galbeni", "county": "Bacau"},
    }
    city_match = {
        "lat": "46.5384858",
        "lon": "26.9095203",
        "type": "primary",
        "display_name": "Strada Narciselor, Bacau, Romania",
        "address": {"road": "Strada Narciselor", "city": "Bacau", "county": "Bacau"},
    }

    picked = geocoding_service._nominatim_pick_best(
        [wrong_county_match, city_match],
        expected_locality="bacau",
        expected_county="bacau",
    )

    assert picked is not None
    assert picked[0] is city_match
