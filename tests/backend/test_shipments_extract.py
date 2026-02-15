from backend.services import shipments_service


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

