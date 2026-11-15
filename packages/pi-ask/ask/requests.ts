import type { AskPrompt, AskResponse } from "./contracts.js";
import { customSelectionFor } from "./state.js";

export interface AskRequest {
	id: string;
	prompts: AskPrompt[];
	handoff: boolean;
	steering: boolean;
}

export type RequestChange =
	| { state: "pending"; request: AskRequest }
	| { state: "closed"; id: string };

type Completion = { error: string } | { message: string };

interface OpenRequest {
	request: AskRequest;
	controller: AbortController;
	selected: boolean;
	resolve: (response: unknown) => void;
	finish: (result: Completion) => void;
	completion: Promise<Completion>;
}

function parseAnswers(prompts: AskPrompt[], text: string): AskResponse[] {
	let input: unknown;
	try {
		input = JSON.parse(text);
	} catch {
		throw new Error("Reply must be a JSON array of answers in prompt order");
	}
	if (!Array.isArray(input) || input.length !== prompts.length)
		throw new Error(`Provide exactly ${prompts.length} answers in prompt order`);
	return prompts.map((prompt, index) => {
		const value: unknown = input[index];
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error(`Answer ${index + 1} must be an object`);
		const answer = value as Record<string, unknown>;
		if (
			Object.keys(answer).some((key) => !["selections", "other", "comment"].includes(key)) ||
			(answer["other"] !== undefined && typeof answer["other"] !== "string") ||
			(answer["comment"] !== undefined && typeof answer["comment"] !== "string")
		)
			throw new Error(`Answer ${index + 1}: use selections, other or comment`);
		const selections = answer["selections"] ?? [];
		if (
			!Array.isArray(selections) ||
			!selections.every(
				(value): value is string =>
					typeof value === "string" && prompt.choices.some((choice) => choice.label === value),
			)
		)
			throw new Error(`Answer ${index + 1}: selections must match choice labels`);
		const selected = [...new Set(selections)];
		if (typeof answer["other"] === "string") selected.push(customSelectionFor(answer["other"]));
		const comment = typeof answer["comment"] === "string" ? answer["comment"].trim() : "";
		if (!selected.length && !comment)
			throw new Error(`Answer ${index + 1}: supply a selection, other or comment`);
		if (!prompt.multiple && selected.length > 1)
			throw new Error(`Answer ${index + 1} accepts only one selection or other`);
		return {
			id: prompt.id,
			selections: selected,
			...(comment ? { comment } : {}),
		};
	});
}

/** Owns the race between the human panel, remote replies and session cancellation. */
export class AskRequests {
	private readonly requests = new Map<string, OpenRequest>();
	private readonly onChange: ((change: RequestChange) => void) | undefined;
	constructor(onChange?: (change: RequestChange) => void) {
		this.onChange = onChange;
	}

	open(request: AskRequest, signal?: AbortSignal) {
		if (this.requests.has(request.id)) throw new Error("Ask is already pending");
		let resolve!: (response: unknown) => void;
		let reject!: (error: unknown) => void;
		let finish!: (result: Completion) => void;
		const response = new Promise<unknown>((done, fail) => {
			resolve = done;
			reject = fail;
		});
		const completion = new Promise<Completion>((done) => {
			finish = done;
		});
		const entry: OpenRequest = {
			request,
			controller: new AbortController(),
			selected: false,
			resolve,
			finish,
			completion,
		};
		const select = (value: unknown) => {
			if (entry.selected) return;
			entry.selected = true;
			resolve(value);
			entry.controller.abort();
		};
		const abort = () => select(null);
		this.onChange?.({ state: "pending", request });
		this.requests.set(request.id, entry);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		return {
			response: response.finally(() => signal?.removeEventListener("abort", abort)),
			signal: entry.controller.signal,
			select,
			fail(error: unknown) {
				if (entry.selected) return;
				entry.selected = true;
				reject(error);
				entry.controller.abort();
			},
		};
	}

	async reply(id: string, text: string): Promise<string> {
		const entry = this.requests.get(id);
		if (!entry)
			throw new Error("This question is no longer pending; read the agent's latest state");
		if (entry.request.handoff)
			throw new Error("This handoff requires the user's action and confirmation");
		if (entry.selected)
			throw new Error("This question already has a response; read the agent's latest state");
		const answers = parseAnswers(entry.request.prompts, text);
		entry.selected = true;
		entry.resolve(answers);
		entry.controller.abort();
		const result = await entry.completion;
		if ("error" in result) throw new Error(result.error);
		return result.message;
	}

	complete(id: string, error?: string): void {
		const entry = this.requests.get(id);
		if (!entry) return;
		this.requests.delete(id);
		try {
			if (!error || !entry.request.steering) this.onChange?.({ state: "closed", id });
			entry.finish(error ? { error } : { message: "Answer accepted" });
		} catch (failure) {
			entry.finish({
				error: `Response received, but question state could not be saved: ${String(failure)}`,
			});
			throw failure;
		}
	}

	reset(): void {
		for (const entry of this.requests.values()) {
			entry.selected = true;
			entry.resolve(null);
			entry.controller.abort();
			this.complete(
				entry.request.id,
				"Session changed before the answer was delivered; read the agent's latest state",
			);
		}
		this.requests.clear();
	}
}
