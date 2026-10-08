import { describe, expect, it } from "vitest";
import { fetchKaggleAccelerators } from "./accelerators";

const SAMPLE_MD = `
## Accelerators

Accelerators available as of Sep 2026:

* NvidiaTeslaT4 (GPU T4 ×2)
* NvidiaTeslaA100
* TpuV5E8 (TPU v5e-8)

Some of these are only available to participants of specific competitions.
`;

describe("fetchKaggleAccelerators", () => {
	it("parses accelerator id and parenthetical description", async () => {
		const result = await fetchKaggleAccelerators(async () => new Response(SAMPLE_MD));
		const ids = result.accelerators.map((a) => a.id);
		expect(ids).toContain("NvidiaTeslaT4");
		expect(ids).toContain("TpuV5E8");
		const t4 = result.accelerators.find((a) => a.id === "NvidiaTeslaT4");
		expect(t4?.description).toMatch(/T4/);
	});
});
