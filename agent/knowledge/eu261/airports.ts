// Coordinates from OurAirports open data (Unlicense): https://github.com/davidmegginson/ourairports-data

export interface Airport {
  icao: string;
  iata: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
}

const AIRPORTS: readonly Airport[] = [
  { icao: "LFPG", iata: "CDG", name: "Paris Charles de Gaulle", country: "FR", lat: 49.00896, lon: 2.554117 },
  { icao: "LEMD", iata: "MAD", name: "Madrid Barajas", country: "ES", lat: 40.493407, lon: -3.572249 },
  { icao: "LEBL", iata: "BCN", name: "Barcelona El Prat", country: "ES", lat: 41.2971, lon: 2.07846 },
  { icao: "LIRF", iata: "FCO", name: "Rome Fiumicino", country: "IT", lat: 41.804532, lon: 12.251998 },
  { icao: "EHAM", iata: "AMS", name: "Amsterdam Schiphol", country: "NL", lat: 52.308601, lon: 4.76389 },
  { icao: "EDDF", iata: "FRA", name: "Frankfurt Main", country: "DE", lat: 50.026706, lon: 8.55835 },
  { icao: "EDDB", iata: "BER", name: "Berlin Brandenburg", country: "DE", lat: 52.361738, lon: 13.502341 },
  { icao: "LPPT", iata: "LIS", name: "Lisbon Humberto Delgado", country: "PT", lat: 38.7813, lon: -9.13592 },
  { icao: "EIDW", iata: "DUB", name: "Dublin", country: "IE", lat: 53.428713, lon: -6.262121 },
  { icao: "EGLL", iata: "LHR", name: "London Heathrow", country: "GB", lat: 51.470748, lon: -0.459909 },
  { icao: "KJFK", iata: "JFK", name: "New York JFK", country: "US", lat: 40.639447, lon: -73.779317 },
  { icao: "DNMM", iata: "LOS", name: "Lagos Murtala Muhammed", country: "NG", lat: 6.57737, lon: 3.32116 },
];

const byCode = new Map<string, Airport>();
for (const a of AIRPORTS) {
  byCode.set(a.icao, a);
  byCode.set(a.iata, a);
}

export function findAirport(code: string): Airport | undefined {
  return byCode.get(code.trim().toUpperCase());
}

// EU Member States (ISO 3166-1 alpha-2); flights from these airports are in scope of Art. 3(1)(a)
export const EU_MEMBER_STATES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);
