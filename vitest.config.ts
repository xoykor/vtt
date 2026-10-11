import { defineConfig } from "vitest/config";

// Unit Vitest (src/**) + E2E Playwright (e2e/**) moram no mesmo repo com
// runners distintos: este exclude impede o Vitest de coletar o spec
// Playwright (e vice-versa o CI chama `playwright test e2e/...`
// explicitamente). Sem este arquivo, `npx vitest run` falharia ao
// importar `@playwright/test` fora do seu runner.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
