import { describe, expect, test } from "bun:test";

const { default: skillsExtension } = await import("./index.ts");

function load() {
	const handlers: Array<(event: never) => void> = [];
	const pi = {
		events: { on: () => () => {}, emit: () => {} },
		on: (_name: string, handler: never) => handlers.push(handler),
		registerTool: () => {},
	};
	const ready = skillsExtension(pi as never);
	return { ready, handler: () => handlers[0]! };
}

function skill(name: string, description: string, disableModelInvocation = false) {
	return { name, description, disableModelInvocation, filePath: `/x/${name}/SKILL.md` };
}

function run(handler: (event: never) => void, skills: unknown[], forceSystemPrompt?: string) {
	const options = { skills, sections: {} as Record<string, string>, forceSystemPrompt };
	handler({ systemPromptOptions: options } as never);
	return options;
}

describe("skill index", () => {
	test("indexes visible skills instead of the catalog", async () => {
		const { ready, handler } = load();
		await ready;
		const options = run(handler(), [skill("a", "Trigger A."), skill("b", "Trigger B.")]);

		expect(options.skills).toEqual([]);
		const index = options.sections.skills!;
		expect(index).toContain("`skills` tool");
		expect(index).toContain("- a: Trigger A.");
		expect(index).toContain("- b: Trigger B.");
		// Locations stay out so the index cannot go stale against moved files.
		expect(index).not.toContain("/x/a/SKILL.md");
	});

	test("leaves out skills the model may not invoke", async () => {
		const { ready, handler } = load();
		await ready;
		const options = run(handler(), [skill("a", "A."), skill("off", "Off.", true)]);

		expect(options.sections.skills).toContain("- a:");
		expect(options.sections.skills).not.toContain("off:");
	});

	test("adds no section when every skill is hidden", async () => {
		const { ready, handler } = load();
		await ready;
		const options = run(handler(), [skill("off", "Off.", true)]);

		expect(options.sections.skills).toBeUndefined();
	});

	test("appends one index to a forced prompt and keeps other text", async () => {
		const { ready, handler } = load();
		await ready;
		const options = run(
			handler(),
			[skill("a", "A.")],
			"<preamble>keep me</preamble>\n<skills>stale</skills>",
		);

		expect(options.forceSystemPrompt).toContain("keep me");
		expect(options.forceSystemPrompt).not.toContain("stale");
		expect(options.forceSystemPrompt!.match(/<skill_index>/g)).toHaveLength(1);
	});

	test("does not duplicate an index a chained handler already wrote", async () => {
		const { ready, handler } = load();
		await ready;
		const options = run(handler(), [skill("a", "A.")], "<skill_index>\nold\n</skill_index>");

		expect(options.forceSystemPrompt!.match(/<skill_index>/g)).toHaveLength(1);
		expect(options.forceSystemPrompt).not.toContain("old");
		expect(options.forceSystemPrompt).toContain("- a: A.");
	});

	test("re-reads the catalog on every run", async () => {
		const { ready, handler } = load();
		await ready;
		run(handler(), [skill("a", "A.")]);
		const second = run(handler(), [skill("b", "B.")]);

		expect(second.sections.skills).toContain("- b: B.");
		expect(second.sections.skills).not.toContain("- a: A.");
	});
});
