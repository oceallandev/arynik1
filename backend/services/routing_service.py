import math
import requests
from typing import List, Tuple

OSRM_BASE_URL = "http://router.project-osrm.org/route/v1/driving"

def calculate_haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the great circle distance between two points 
    on the earth (specified in decimal degrees)
    """
    # Convert decimal degrees to radians 
    lon1, lat1, lon2, lat2 = map(math.radians, [lon1, lat1, lon2, lat2])

    # Haversine formula 
    dlon = lon2 - lon1 
    dlat = lat2 - lat1 
    a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2
    c = 2 * math.asin(math.sqrt(a)) 
    r = 6371 # Radius of earth in kilometers. Use 3956 for miles
    return c * r

def get_osrm_route(coordinates: List[Tuple[float, float]]) -> dict:
    """
    Get route from OSRM demo server. 
    Coordinates format: [(lon, lat), (lon, lat)] -> OSRM uses lon,lat
    """
    if len(coordinates) < 2:
        return None
        
    # Format coordinates string for OSRM: lon1,lat1;lon2,lat2
    coord_string = ";".join([f"{lon},{lat}" for lon, lat in coordinates])
    
    url = f"{OSRM_BASE_URL}/{coord_string}?overview=full&geometries=geojson"
    try:
        response = requests.get(url, timeout=5)
        if response.status_code == 200:
            return response.json()
    except Exception as e:
        print(f"OSRM Error: {e}")
    return None

def optimize_route_order(start_location: Tuple[float, float], destinations: List[dict]) -> List[dict]:
    """
    Basic Nearest Neighbor optimization logic.
    destinations: list of dicts with 'id', 'lat', 'lon'
    """
    if not destinations:
        return []

    optimized = []
    current_pos = start_location
    pool = destinations.copy()

    while pool:
        nearest = None
        min_dist = float('inf')
        
        for dest in pool:
            dist = calculate_haversine_distance(
                current_pos[0], current_pos[1], 
                dest['lat'], dest['lon']
            )
            if dist < min_dist:
                min_dist = dist
                nearest = dest
        
        if nearest:
            nearest['distance_from_prev'] = round(min_dist, 2)
            optimized.append(nearest)
            current_pos = (nearest['lat'], nearest['lon'])
            pool.remove(nearest)
            
    return optimized

def calculate_path_distance(coordinates: List[Tuple[float, float]]) -> float:
    """
    Calculate total distance of a path (list of lat/lon tuples).
    Returns distance in km.
    """
    if len(coordinates) < 2:
        return 0.0
    
    total_dist = 0.0
    for i in range(len(coordinates) - 1):
        total_dist += calculate_haversine_distance(
            coordinates[i][0], coordinates[i][1],
            coordinates[i+1][0], coordinates[i+1][1]
        )
    return round(total_dist, 2)

