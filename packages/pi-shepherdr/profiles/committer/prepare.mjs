import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const STATUS_LIMIT = 400;
const LOG_LIMIT = 15;
const PREFIXED = /^[a-z]+(\([a-z0-9-]+\))?!?: /;

function runGit(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		timeout: GIT_TIMEOUT_MS,
	});
	if (result.error) throw result.error;
	return {
		code: result.status ?? 1,
		stderr: result.stderr.trim(),
		stdout: result.stdout.trim(),
	};
}

function gitString(cwd, args) {
	const result = runGit(cwd, args);
	if (result.code !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git ${args.join(" ")} failed with exit ${result.code}`,
		);
	}
	return result.stdout;
}

/** Collapse a long list to a head, so one huge tree cannot crowd out the brief. */
function bounded(value, limit) {
	const lines = value.split("\n");
	if (lines.length <= limit) return value || "(none)";
	return `${lines.slice(0, limit).join("\n")}\n… ${lines.length - limit} more line(s)`;
}

function section(title, body) {
	return [`<${title}>`, body, `</${title}>`].join("\n");
}

/** `origin/main` etc. beats guessing; a detached HEAD has no local branch. */
function upstream(cwd) {
	const ref = runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	if (ref.code === 0 && ref.stdout) return ref.stdout;
	for (const candidate of ["origin/main", "origin/master", "origin/dev"]) {
		if (runGit(cwd, ["rev-parse", "--verify", "--quiet", candidate]).code === 0) return candidate;
	}
	return undefined;
}

/** /tmp and /private/tmp are the same tree; compare through symlinks. */
function samePath(left, right) {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return left === right;
	}
}

/** `rev-parse --git-path` returns a path whether or not it exists. */
function gitPathExists(root, name) {
	const result = runGit(root, ["rev-parse", "--git-path", name]);
	return result.code === 0 && result.stdout !== "" && existsSync(resolve(root, result.stdout));
}

function collect(cwd) {
	const root = gitString(cwd, ["rev-parse", "--show-toplevel"]);
	const status = gitString(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const stagedFull = gitString(root, ["diff", "--staged", "--stat"]);
	const branch = gitString(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const log = gitString(root, ["log", `-${LOG_LIMIT}`, "--format=%s"]);
	const recentBodies = gitString(root, ["log", "-3", "--format=%B---8<---", "--no-merges"])
		.split("---8<---")
		.map((body) => body.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
	const range = upstream(root);
	const ahead =
		range && runGit(root, ["rev-list", "--count", `${range}..HEAD`]).stdout
			? runGit(root, ["rev-list", "--count", `${range}..HEAD`]).stdout
			: undefined;
	const conflicts = gitString(root, ["diff", "--name-only", "--diff-filter=U"]);
	const counts = runGit(root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
	return {
		root,
		subdirectory: !samePath(root, cwd) ? cwd : undefined,
		status,
		staged: stagedFull,
		branch,
		log,
		recentBodies,
		range,
		ahead,
		conflicts,
		counts: counts.code === 0 ? counts.stdout : undefined,
	};
}

function safe(value) {
	return String(value).replaceAll("</", "&lt;/");
}

export function prepare(input) {
	const mentioned = `Commit request:\n${input.message}`;
	if (input.local === false) {
		// Peer git cannot see the worker's checkout and would describe the wrong tree.
		return [
			"Commit context:",
			"Repository root: (remote machine, not inspected here)",
			"The tree lives on another machine. Run the audit's three commands yourself from the given working directory before staging anything; do not assume it is clean or that the branch matches the controller.",
			"",
			"Instructions:",
			mentioned,
		].join("\n");
	}
	if (runGit(input.cwd, ["rev-parse", "--show-toplevel"]).code !== 0) {
		return [
			"Commit context:",
			`Working directory: ${input.cwd}`,
			"Not a Git repository (or git is unavailable), so the tree could not be inspected.",
			"",
			"Instructions:",
			mentioned,
		].join("\n");
	}
	const state = collect(input.cwd);
	const staging = state.staged || "(nothing staged)";
	const untyped = state.log.split("\n").filter((line) => line && !PREFIXED.test(line)).length;
	const warnings = [];
	if (state.conflicts) warnings.push(`Unmerged paths need resolving first: ${state.conflicts}.`);
	if (state.branch === "HEAD")
		warnings.push("Detached HEAD; commits here are unreachable once moved.");
	if (gitPathExists(state.root, "rebase-merge") || gitPathExists(state.root, "rebase-apply"))
		warnings.push("A rebase is in progress; check before committing.");
	if (gitPathExists(state.root, "MERGE_HEAD")) warnings.push("A merge is in progress.");
	if (state.ahead && state.ahead !== "0" && !state.status)
		warnings.push(
			`Clean but ${state.ahead} commit(s) ahead of ${state.range}; there may be nothing to split.`,
		);
	const ignored = runGit(state.root, ["status", "--porcelain", "--ignored=matching", "-uall"]);
	const secretish =
		ignored.code === 0
			? ignored.stdout
					.split("\n")
					.filter((line) => line.startsWith("!! "))
					.map((line) => line.slice(3))
			: [];

	return [
		"Commit context:",
		`Repository root: ${state.root}`,
		...(state.subdirectory
			? [`Requested directory: ${state.subdirectory} (a subdirectory; git acts on the whole repo)`]
			: []),
		`Current branch: ${state.branch}`,
		...(state.range ? [`Upstream: ${state.range}`] : ["Upstream: none configured"]),
		...(state.ahead ? [`Ahead of upstream: ${state.ahead} commit(s)`] : []),
		...(state.counts ? [`Ahead/behind: ${state.counts}`] : []),
		...(warnings.length ? ["", "State warnings:", ...warnings.map((line) => `- ${line}`)] : []),
		"",
		`Recent subjects. ${
			untyped
				? `${untyped} are older and unprefixed: match its tone, not its shape. The rest are typed: copy their shape too.`
				: "All are typed: copy their shape."
		}`,
		section("recent_log", safe(bounded(state.log, LOG_LIMIT))),
		"",
		"Recent bodies, shape to match:",
		section("recent_bodies", safe(state.recentBodies || "(none)")),
		"",
		"Working tree (first column = index, second = worktree):",
		section("git_status", safe(bounded(state.status || "(clean)", STATUS_LIMIT))),
		"",
		"Already staged, per file:",
		section("git_diff_staged_stat", safe(staging)),
		...(secretish.length
			? [
					"",
					"Ignored-but-present paths worth a glance for secrets:",
					section("ignored", safe(bounded(secretish.join("\n"), 40))),
				]
			: []),
		"",
		"Re-read the full diffs yourself before staging; these are summaries.",
		"",
		"Instructions:",
		mentioned,
	].join("\n");
}
