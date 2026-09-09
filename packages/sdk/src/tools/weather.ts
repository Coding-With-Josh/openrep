// weather lookups against open-meteo (no api key needed). a place name is
// geocoded first when coordinates are not given directly; both requests go
// through the shared ssrf guard. output is a compact snapshot of current
// conditions, with the wmo weather code mapped to a plain description.
import type { ToolDefinition, ToolImplementation } from "../types/providers.js";
import { readJsonBody, safeFetch, ToolError } from "./guards.js";

const OPEN_METEO_ORIGIN = "https://api.open-meteo.com";
const GEOCODING_ORIGIN = "https://geocoding-api.open-meteo.com";

function describeWeatherCode(code: number): string {
  if (code === 0) return "clear sky";
  if (code <= 3) return "partly cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return "unknown conditions";
}

interface Coordinates {
  label: string;
  latitude: number;
  longitude: number;
}

async function geocode(place: string): Promise<Coordinates> {
  const url = new URL("/v1/search", GEOCODING_ORIGIN);
  url.searchParams.set("name", place);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  const result = await safeFetch(url.toString());
  if (result.status !== 200) {
    throw new ToolError(`geocoding returned status ${result.status}`);
  }
  const body = readJsonBody(result.body) as { results?: unknown };
  const results = Array.isArray(body.results) ? body.results : [];
  const first = results.length > 0 ? (results[0] as { name?: unknown; latitude?: unknown; longitude?: unknown; country?: unknown }) : undefined;
  if (first === undefined) {
    throw new ToolError(`no location found for "${place}"`);
  }
  const { latitude, longitude } = first;
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    throw new ToolError("geocoding returned malformed coordinates");
  }
  const name = typeof first.name === "string" ? first.name : place;
  const country = typeof first.country === "string" ? first.country : undefined;
  return {
    label: country === undefined ? name : `${name}, ${country}`,
    latitude,
    longitude,
  };
}

async function fetchCurrent(coords: Coordinates) {
  const url = new URL("/v1/forecast", OPEN_METEO_ORIGIN);
  url.searchParams.set("latitude", String(coords.latitude));
  url.searchParams.set("longitude", String(coords.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
  );
  url.searchParams.set("timezone", "auto");
  const result = await safeFetch(url.toString());
  if (result.status !== 200) {
    throw new ToolError(`weather service returned status ${result.status}`);
  }
  return readJsonBody(result.body) as {
    current?: {
      time?: unknown;
      temperature_2m?: unknown;
      relative_humidity_2m?: unknown;
      apparent_temperature?: unknown;
      weather_code?: unknown;
      wind_speed_10m?: unknown;
    };
  };
}

const weatherDefinition: ToolDefinition = {
  name: "weather",
  description:
    `get current weather conditions. provide either "place" (a city or place name) or explicit "latitude" and "longitude" numbers. returns temperature, apparent temperature, humidity, wind speed, and conditions.`,
  inputSchema: {
    type: "object",
    properties: {
      place: { type: "string", minLength: 1, maxLength: 200 },
      latitude: { type: "number" },
      longitude: { type: "number" },
    },
    additionalProperties: false,
  },
};

const weatherImplementation: ToolImplementation = async (args: unknown) => {
  const { place, latitude, longitude } = args as { place?: unknown; latitude?: unknown; longitude?: unknown };
  let coords: Coordinates;
  if (typeof place === "string" && place.length > 0) {
    if (latitude !== undefined || longitude !== undefined) {
      throw new ToolError("provide either place or coordinates, not both");
    }
    coords = await geocode(place);
  } else if (typeof latitude === "number" && typeof longitude === "number") {
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new ToolError("latitude must be within -90..90 and longitude within -180..180");
    }
    coords = { label: `${latitude}, ${longitude}`, latitude, longitude };
  } else {
    throw new ToolError("provide a place name or latitude and longitude");
  }

  const body = await fetchCurrent(coords);
  const current = body.current;
  if (current === undefined || typeof current !== "object") {
    throw new ToolError("weather service returned no current conditions");
  }
  const code = current.weather_code;
  if (typeof code !== "number") {
    throw new ToolError("weather service returned a malformed weather code");
  }
  return {
    location: coords.label,
    temperatureCelsius:
      typeof current.temperature_2m === "number" ? current.temperature_2m : null,
    apparentTemperatureCelsius:
      typeof current.apparent_temperature === "number" ? current.apparent_temperature : null,
    humidityPercent:
      typeof current.relative_humidity_2m === "number" ? current.relative_humidity_2m : null,
    windSpeedKmh: typeof current.wind_speed_10m === "number" ? current.wind_speed_10m : null,
    conditions: describeWeatherCode(code),
    observedAt: typeof current.time === "string" ? current.time : null,
  };
};

export const weatherTool: readonly { definition: ToolDefinition; implementation: ToolImplementation }[] = [
  { definition: weatherDefinition, implementation: weatherImplementation },
];