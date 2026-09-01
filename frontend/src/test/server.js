import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export const server = setupServer(
  http.get("http://localhost:3000/api/auth/config", () => HttpResponse.json({ enabled: false })),
);
