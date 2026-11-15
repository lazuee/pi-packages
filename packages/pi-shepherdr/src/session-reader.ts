import { readSessionView } from "./remote/shepherdr-session.mjs";
import { watchSessions } from "./remote/shepherdr-session-watch.mjs";
import type { LatestAssistant, SessionView } from "./types.js";

export class SessionReader {
	async watch(
		paths: string[],
		onChange: (path: string) => void,
		onError: (error: Error) => void,
		signal: AbortSignal,
	): Promise<() => void> {
		return watchSessions(paths, onChange, onError, signal);
	}
	async view(path?: string): Promise<SessionView> {
		return readSessionView(path);
	}
	async latest(path?: string): Promise<LatestAssistant | undefined> {
		return (await this.view(path)).assistant;
	}
}
export interface AssistantReader {
	watch(
		paths: string[],
		onChange: (path: string) => void,
		onError: (error: Error) => void,
		signal: AbortSignal,
	): Promise<() => void>;
	latest(path?: string): Promise<LatestAssistant | undefined>;
	view(path?: string): Promise<SessionView>;
}
