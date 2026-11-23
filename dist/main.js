import { chmod, chown, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
// node_modules/.pnpm/@intentic+base@1.430.0/node_modules/@intentic/base/dist/errors.js
var errorMessage = (error) => error instanceof Error ? error.message : String(error);
var errnoCode = (error) => {
	const code = typeof error === `object` && error !== null ? error.code : void 0;
	return typeof code === `string` ? code : void 0;
};
var isMissing = (error) => {
	const code = errnoCode(error);
	return code === `ENOENT` || code === `ENOTDIR`;
};
var undefinedIfMissing = (error) => {
	if (isMissing(error)) return;
	throw error;
};
var sleep = (ms, options) => new Promise((resolve) => {
	const signal = options?.signal;
	if (signal?.aborted === true) {
		resolve();
		return;
	}
	const done = () => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", done);
		resolve();
	};
	const timer = setTimeout(done, ms);
	if (options?.unref === true) timer.unref?.();
	signal?.addEventListener("abort", done, { once: true });
});
// node_modules/.pnpm/@intentic+base@1.430.0/node_modules/@intentic/base/dist/node/windows-stop.js
var WINDOWS_LAUNCHER = "intentic-launch.exe";
var windowsLauncher = (execPath = process.execPath) => {
	if (process.platform !== "win32") return;
	const candidate = join(dirname(execPath), WINDOWS_LAUNCHER);
	return existsSync(candidate) ? candidate : void 0;
};
var BREAK_SENT = 0;
var BREAK_HAS_WINDOW = 3;
var closeAskedBy = (breakCode, taskkillCode) => {
	if (breakCode === BREAK_SENT) return "console";
	if (breakCode === BREAK_HAS_WINDOW) return "window";
	return taskkillCode === 0 ? "window" : "unasked";
};
var exitOf = (program, args, timeoutMs) => new Promise((resolve) => {
	let child;
	try {
		child = spawn(program, [...args], {
			stdio: "ignore",
			windowsHide: true
		});
	} catch {
		resolve(null);
		return;
	}
	const timer = setTimeout(() => {
		child.kill();
		resolve(null);
	}, timeoutMs);
	child.once("error", () => {
		clearTimeout(timer);
		resolve(null);
	});
	child.once("exit", (code) => {
		clearTimeout(timer);
		resolve(code);
	});
});
var TASKKILL_MS = 3e4;
var BREAK_MS = 15e3;
var askWindowsTreeToClose = async (pid, { consoleOf = pid, launcher = windowsLauncher(), except = process.pid } = {}) => {
	const posted = await exitOf("taskkill", [
		"/PID",
		String(pid),
		"/T"
	], TASKKILL_MS);
	return closeAskedBy(launcher === void 0 ? void 0 : await exitOf(launcher, [
		"--ctrl-break",
		String(consoleOf),
		"--except",
		String(except)
	], BREAK_MS), posted);
};
var forceWindowsTree = async (pid) => {
	await exitOf("taskkill", [
		"/PID",
		String(pid),
		"/T",
		"/F"
	], TASKKILL_MS);
};
var WINDOWS_SWEEP_TIMEOUT_MS = 15e3;
var windowsDescendantSweep = (pid, since) => [
	"$ErrorActionPreference='SilentlyContinue'",
	`$since=[DateTime]::Parse('${(/* @__PURE__ */ new Date(since - 1e3)).toISOString()}').ToUniversalTime()`,
	"$all=@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate.ToUniversalTime() -ge $since })",
	`$queue=[System.Collections.Generic.Queue[uint32]]::new(); $queue.Enqueue(${pid})`,
	"while($queue.Count -gt 0){ $parent=$queue.Dequeue(); foreach($p in $all){ if($p.ParentProcessId -eq $parent){ $queue.Enqueue($p.ProcessId); Stop-Process -Id $p.ProcessId -Force } } }"
].join("; ");
var windowsPowershell = () => `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
var hasExited = (child) => child.exitCode !== null || child.signalCode !== null;
var stopWindowsTree = async (child, pid, killGraceMs, startedAt) => {
	const exited = new Promise((resolve) => {
		if (hasExited(child)) {
			resolve();
			return;
		}
		child.once("exit", () => resolve());
	});
	if (!hasExited(child)) {
		await askWindowsTreeToClose(pid);
		await Promise.race([exited, sleep(killGraceMs, { unref: true })]);
	}
	if (!hasExited(child)) await forceWindowsTree(pid);
	else if (startedAt !== void 0) await new Promise((resolve) => {
		spawn(windowsPowershell(), [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			windowsDescendantSweep(pid, startedAt)
		], {
			stdio: "ignore",
			windowsHide: true,
			timeout: WINDOWS_SWEEP_TIMEOUT_MS
		}).once("exit", () => resolve()).once("error", () => resolve());
	});
	child.kill();
};
var PIPE_QUIET_MS = 1e3;
var PIPE_LINGER_MS = 5e3;
var PIPE_POLL_MS = 50;
var KILL_GRACE_MS = 2e3;
var textCollector = (maxOutput) => {
	const decoder = new StringDecoder("utf8");
	const half = Math.floor(maxOutput / 2);
	let head = "";
	let tail = "";
	let dropped = 0;
	const take = (text) => {
		const room = Math.max(half - head.length, 0);
		head += text.slice(0, room);
		tail += text.slice(room);
		if (tail.length > half) {
			dropped += tail.length - half;
			tail = tail.slice(-half);
		}
	};
	return {
		write: (chunk) => take(decoder.write(chunk)),
		end: () => {
			take(decoder.end());
			return {
				text: dropped === 0 ? `${head}${tail}` : `${head}\n… [${dropped} characters cut] …\n${tail}`,
				dropped
			};
		}
	};
};
var delay = (ms) => sleep(ms, { unref: true });
var signalGroup = (pid, signal) => {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (errnoCode(error) !== "ESRCH") throw error;
	}
};
var GROUP_POLL_MS = 25;
var EXITED_STATES = /* @__PURE__ */ new Set([
	"Z",
	"X",
	"x"
]);
var NUMERIC = /^\d+$/;
var procStatOf = (pid) => {
	let stat;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		const code = errnoCode(error);
		if (code === "ENOENT" || code === "ESRCH") return "gone";
		throw error;
	}
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return {
		state: fields[0] ?? "",
		group: Number(fields[2])
	};
};
var groupHasLivingMember = (pgid) => {
	let names;
	try {
		names = readdirSync("/proc").filter((name) => NUMERIC.test(name));
	} catch {
		return;
	}
	for (const name of names.toReversed()) {
		let stat;
		try {
			stat = procStatOf(name);
		} catch {
			return;
		}
		if (stat !== "gone" && stat.group === pgid && !EXITED_STATES.has(stat.state)) return true;
	}
	return false;
};
var groupAlive = (pid) => {
	try {
		process.kill(-pid, 0);
	} catch (error) {
		return errnoCode(error) !== "ESRCH";
	}
	return process.platform === "linux" ? groupHasLivingMember(pid) ?? true : true;
};
var stopProcessTree = async (child, killGraceMs = KILL_GRACE_MS, startedAt) => {
	const pid = child.pid;
	if (pid === void 0) return;
	if (process.platform === "win32") {
		await stopWindowsTree(child, pid, killGraceMs, startedAt);
		return;
	}
	signalGroup(pid, "SIGTERM");
	const until = Date.now() + killGraceMs;
	while (groupAlive(pid) && Date.now() < until) await delay(GROUP_POLL_MS);
	signalGroup(pid, "SIGKILL");
};
var spawnOptions = (options) => {
	const spawned = {
		stdio: [
			options.input === void 0 ? "ignore" : "pipe",
			"pipe",
			"pipe"
		],
		detached: process.platform !== "win32",
		windowsHide: true
	};
	if (options.cwd !== void 0) spawned.cwd = options.cwd;
	if (options.env !== void 0) spawned.env = options.env;
	return spawned;
};
var start = (command, args, options) => {
	try {
		return spawn(command, [...args], spawnOptions(options));
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
};
var stopperFor = (child, options) => {
	const startedAt = Date.now();
	let stopping;
	let timedOut = false;
	let aborted = false;
	const stop = () => {
		stopping ??= stopProcessTree(child, options.killGraceMs, startedAt);
	};
	const deadline = options.timeoutMs === void 0 ? void 0 : setTimeout(() => {
		timedOut = true;
		stop();
	}, options.timeoutMs);
	const onAbort = () => {
		aborted = true;
		stop();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	return {
		timedOut: () => timedOut,
		aborted: () => aborted,
		stopped: async () => {
			await stopping;
		},
		dispose: () => {
			clearTimeout(deadline);
			options.signal?.removeEventListener("abort", onAbort);
		}
	};
};
var drain = async (child, closed, lastData) => {
	const exitedAt = Date.now();
	for (;;) {
		if (await Promise.race([closed, delay(PIPE_POLL_MS).then(() => false)])) return true;
		const now = Date.now();
		if (now - lastData() >= PIPE_QUIET_MS || now - exitedAt >= PIPE_LINGER_MS) {
			child.stdout?.destroy();
			child.stderr?.destroy();
			return false;
		}
	}
};
var run = async (command, args, options, stdout) => {
	const stderr = textCollector(options.maxOutput ?? 8388608);
	const failed = (spawnError, aborted) => ({
		exitCode: null,
		exitSignal: null,
		stdout: stdout.end(),
		stderr: stderr.end(),
		timedOut: false,
		aborted,
		lingering: false,
		spawnError
	});
	if (options.signal?.aborted === true) return failed(/* @__PURE__ */ new Error(`${command} was not started: the call was aborted`), true);
	const child = start(command, args, options);
	if (child instanceof Error) return failed(child, false);
	options.onSpawn?.(child);
	let lastData = Date.now();
	const heard = (sink) => (chunk) => {
		lastData = Date.now();
		sink.write(chunk);
	};
	child.stdout?.on("data", heard(stdout));
	child.stderr?.on("data", heard(stderr));
	if (options.input !== void 0 && child.stdin !== null) {
		child.stdin.on("error", () => void 0);
		child.stdin.end(options.input);
	}
	const closed = new Promise((resolve) => child.once("close", () => resolve(true)));
	const stopper = stopperFor(child, options);
	const ended = await new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({
			code,
			signal
		}));
		child.once("error", (error) => resolve(error));
	});
	stopper.dispose();
	if (ended instanceof Error) return failed(ended, stopper.aborted());
	await stopper.stopped();
	const drained = await drain(child, closed, () => lastData);
	return {
		exitCode: ended.code,
		exitSignal: ended.signal,
		stdout: stdout.end(),
		stderr: stderr.end(),
		timedOut: stopper.timedOut(),
		aborted: stopper.aborted(),
		lingering: !drained
	};
};
var runBounded = async (command, args, options = {}) => await run(command, args, options, textCollector(options.maxOutput ?? 8388608));
var ProcessError = class extends Error {
	code;
	killed;
	signal;
	stdout;
	stderr;
	timedOut;
	constructor(command, args, result) {
		const line = [command, ...args].join(" ");
		const reason = result.spawnError !== void 0 ? result.spawnError.message : result.timedOut ? "it ran past its deadline and was stopped" : result.aborted ? "it was aborted" : `exit ${result.exitCode ?? result.exitSignal ?? "unknown"}`;
		super(`Command failed: ${line} (${reason})${result.stderr.text.trim() === "" ? "" : `\n${result.stderr.text.trimEnd()}`}`, result.spawnError === void 0 ? {} : { cause: result.spawnError });
		this.name = "ProcessError";
		this.code = result.spawnError !== void 0 ? errnoCode(result.spawnError) : result.exitCode ?? void 0;
		this.killed = result.timedOut || result.aborted;
		this.signal = result.exitSignal;
		this.stdout = result.stdout.text;
		this.stderr = result.stderr.text;
		this.timedOut = result.timedOut;
	}
};
var execBounded = async (command, args, options = {}) => {
	const result = await runBounded(command, args, options);
	if (result.exitCode !== 0) throw new ProcessError(command, args, result);
	return {
		stdout: result.stdout.text,
		stderr: result.stderr.text
	};
};
// src/workspace.ts
var findWorkspaceRoot = (env, cwd, probe = ".intentic") => {
	const declared = env["INTENTIC_WORKSPACE"];
	if (declared !== void 0 && declared !== "") return declared;
	for (let dir = cwd;; dir = dirname(dir)) {
		if (existsSync(join(dir, probe))) return dir;
		if (dirname(dir) === dir) return env["WORKSPACE_ROOT"] ?? "/work";
	}
};
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function joinValues(array, separator = "|") {
	return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
var Cached = class {
	constructor(getter) {
		this._getter = getter;
		this._value = void 0;
	}
	get value() {
		const getter = this._getter;
		if (getter !== void 0) {
			this._value = getter();
			this._getter = void 0;
		}
		return this._value;
	}
};
function cached(getter) {
	return new Cached(getter);
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const ratio = val / step;
	const roundedRatio = Math.round(ratio);
	const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
	if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
	return ratio - roundedRatio;
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
/**
* Whichever object a def's `shape` currently answers from: the one the caller passed until the first read, the frozen copy after it.
*
* Its keys and descriptors read without invoking anything, which is what lets a discriminated union check its discriminator, and the cycle walk read a shape, without resolving a getter that references the schema being constructed. A def that answers `shape` from an accessor of its own has none.
*/
function rawShape(def) {
	const desc = Object.getOwnPropertyDescriptor(def, "shape");
	return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
	return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
	Object.defineProperty(target, key, {
		get() {
			const value = getter();
			assignProp(this, key, value);
			return value;
		},
		enumerable: true,
		configurable: true
	});
}
function putProp(target, key, value) {
	if (key in target) assignProp(target, key, value);
	else target[key] = value;
}
/**
* Copies `keys` of `source`'s shape onto `target`, each value passed through `wrap`.
*
* A key the source has resolved is copied through now, so the derived shape states it outright and nothing has to resolve it to learn what it holds. A key the source still defers stays deferred, and reads back through the source's own `shape`, so it resolves once and both shapes get that one schema.
*/
function mirrorShape(target, source, keys, wrap) {
	const raw = sourceShape(source);
	for (const key of keys) {
		const desc = Object.getOwnPropertyDescriptor(raw, key);
		if (!desc.enumerable) continue;
		if (desc.get) deferProp(target, key, () => {
			const value = source._zod.def.shape[key];
			return wrap ? wrap(value, key) : value;
		});
		else putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
	}
}
function mirrorProps(target, source) {
	for (const key of Reflect.ownKeys(source)) {
		const desc = Object.getOwnPropertyDescriptor(source, key);
		if (!desc.enumerable) continue;
		if (desc.get) deferProp(target, key, () => source[key]);
		else putProp(target, key, desc.value);
	}
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__*/ cached(() => {
	if (globalConfig.jitless) return false;
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	if (o instanceof Map) return new Map(o);
	if (o instanceof Set) return new Set(o);
	return o;
}
var propertyKeyTypes = /* @__PURE__*/ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function stringifyPrimitive(value) {
	if (typeof value === "bigint") return value.toString() + "n";
	if (typeof value === "string") return `"${value}"`;
	return `${value}`;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin !== void 0 && shape[k]._zod.optout === "optional";
	});
}
var NUMBER_FORMAT_RANGES = /*@__PURE__*/ (() => ({
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
var BIGINT_FORMAT_RANGES = {
	int64: [/* @__PURE__*/ BigInt("-9223372036854775808"), /* @__PURE__*/ BigInt("9223372036854775807")],
	uint64: [/* @__PURE__*/ BigInt(0), /* @__PURE__*/ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	const newShape = {};
	mirrorShape(newShape, schema, maskedKeys(schema, mask));
	return clone(schema, mergeDefs(currDef, {
		shape: newShape,
		checks: []
	}));
}
function maskedKeys(schema, mask) {
	const raw = sourceShape(schema);
	const keys = [];
	for (const key of Reflect.ownKeys(mask)) {
		if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) throw new Error(`Unrecognized key: "${String(key)}"`);
		if (mask[key]) keys.push(key);
	}
	return keys;
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	const omitted = new Set(maskedKeys(schema, mask));
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
	return clone(schema, mergeDefs(currDef, {
		shape: newShape,
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = sourceShape(schema);
		for (const key of Reflect.ownKeys(shape)) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
	mirrorProps(newShape, shape);
	return newShape;
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge(a, b) {
	if (!b?._zod?.def) throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
	if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	const newShape = {};
	mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
	mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
	return clone(a, mergeDefs(a._zod.def, {
		shape: newShape,
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: b._zod.def.checks ?? []
	}));
}
function partial(Class, schema, mask, name = "partial") {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
	const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class && ((value, key) => selected && !selected.has(key) ? value : new Class({
		type: "optional",
		innerType: value
	})));
	return clone(schema, mergeDefs(schema._zod.def, {
		shape: newShape,
		checks: []
	}));
}
function required$1(Class, schema, mask) {
	const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => selected && !selected.has(key) ? value : new Class({
		type: "nonoptional",
		innerType: value
	}));
	return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function explicitlyAborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
/** The leading size checks of `defChecks` that set an upper bound, each paired with it. */
function sizeCaps(defChecks) {
	const caps = [];
	for (const ch of defChecks ?? []) {
		const d = ch._zod.def;
		if (!/_(length|size)$|_equals$/.test(d.check)) break;
		const max = d.maximum ?? d.length ?? d.size;
		if (max >= 0) caps.push([max, ch]);
	}
	return caps;
}
function attachSchema(issues, start, inst) {
	var _a;
	for (let i = start; i < issues.length; i++) (_a = issues[i]).schema ?? (_a.schema = inst);
}
function finalizeIssue(iss, ctx, config) {
	var _a;
	const traits = iss.inst?._zod?.traits;
	if (traits?.has("$ZodType")) {
		if (traits.has("$ZodCheck")) (_a = iss).schema ?? (_a.schema = iss.inst);
		else iss.schema = iss.inst;
	}
	const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : void 0;
	const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	const full = {};
	for (const k of Object.keys(iss)) {
		if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__") continue;
		full[k] = iss[k];
	}
	full.path ?? (full.path = []);
	full.message = message;
	if (ctx?.reportInput) full.input = iss.input;
	return full;
}
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
	const units = str.length;
	if (!highSurrogate.test(str)) return units;
	let count = units;
	for (let i = 0; i < units - 1; i++) if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
		count--;
		i++;
	}
	return count;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function parsedType(data) {
	const t = typeof data;
	switch (t) {
		case "number": return Number.isNaN(data) ? "nan" : "number";
		case "object": {
			if (data === null) return "null";
			if (Array.isArray(data)) return "array";
			const obj = data;
			if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) return obj.constructor.name;
		}
	}
	return t;
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
/**
* Installs a trait's members on its prototype. Each value builds that member for the instance on first read; the built value shadows the accessor as an own property, so a detached `const { parse } = schema` keeps working.
*
* Call this from a `proto` initializer, which runs once per prototype — never per instance.
*/
function members(proto, table) {
	for (const key in table) {
		const desc = Object.getOwnPropertyDescriptor(table, key);
		if (desc.get) Object.defineProperty(proto, key, {
			...desc,
			enumerable: false
		});
		else defineBound(proto, key, desc.value);
	}
}
/** Shadows a prototype member with an own value, so a getter that builds from the instance runs once. */
function own(inst, key, value, enumerable = true) {
	Object.defineProperty(inst, key, {
		configurable: true,
		writable: true,
		enumerable,
		value
	});
	return value;
}
/** Like {@link own}, for a member that was never an own data property and has to stay out of `Object.keys`. */
function hide(inst, key, value) {
	return own(inst, key, value, false);
}
/** Adds members a table derives from the instance: each builds on first read and shadows as own data, and assignment shadows the same way, as when these were own properties. */
/* @__NO_SIDE_EFFECTS__ */
function derived(computes, table) {
	for (const key in computes) {
		const compute = computes[key];
		Object.defineProperty(table, key, {
			configurable: true,
			enumerable: true,
			get() {
				return own(this, key, compute(this));
			},
			set(value) {
				own(this, key, value);
			}
		});
	}
	return table;
}
function defineBound(proto, key, fn) {
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			return this == null ? fn : own(this, key, fn.bind(this));
		},
		set(value) {
			own(this, key, value);
		}
	});
}
/** Returns the prototype to install on, or `undefined` if this group is already installed on it. */
function claim(inst, sentinel) {
	const proto = Object.getPrototypeOf(inst);
	return sentinel in proto ? void 0 : proto;
}
var installing;
var broke = false;
var breaker = {
	configurable: true,
	get() {
		broke = true;
	}
};
/**
* Installs a lazily-derived internal on the `_zod` prototype of `inst`'s
* constructor, computed from the internals object itself and cached there on
* first read. One accessor per constructor rather than one per instance.
*/
function defineLazyInternal(inst, key, compute) {
	const proto = Object.getPrototypeOf(inst._zod);
	if (key in proto && installing !== inst._zod) {
		installing = void 0;
		return;
	}
	installing = inst._zod;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			Object.defineProperty(this, key, breaker);
			const outer = broke;
			broke = false;
			try {
				const value = compute(this);
				if (broke) delete this[key];
				else Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					value
				});
				broke = broke || outer;
				return value;
			} catch (err) {
				delete this[key];
				broke = broke || outer;
				throw err;
			}
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				value
			});
		}
	});
}
/**
* Installs `key` on `inst`'s prototype, computed by `make` on first read and cached there as an own
* data property. One accessor per constructor rather than one per instance, because an own accessor
* puts every instance after the first into v8 dictionary mode. The key doubles as the sentinel.
*/
function installLazyProp(inst, key, make, enumerable) {
	const proto = claim(inst, key);
	if (!proto) return;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			const desc = {
				configurable: true,
				writable: true,
				enumerable,
				value: void 0
			};
			Object.defineProperty(this, key, desc);
			desc.value = make(this);
			Object.defineProperty(this, key, desc);
			return desc.value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				enumerable,
				value
			});
		}
	});
}
/** Marks the thunk `_catch` synthesises for a constant catch value. `Function.length` cannot tell that thunk from a user callback — rest and defaulted parameters both report arity 0 — and a user callback reads `ctx.error`, whose issues only finalize correctly against the caller's per-parse error map. Provenance can say what arity cannot. A plain string key rather than `Symbol.for`, whose call at module scope no bundler can prove pure — the same shape that anchored `urlCanParse` into every build. */
var CONSTANT_CATCH = "~constantCatch";
/** Wraps a constant catch value in a thunk tagged with {@link CONSTANT_CATCH}. */
function constantCatch(value) {
	const fn = () => value;
	fn[CONSTANT_CATCH] = true;
	return fn;
}
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/core.js
var _a$1;
var _zodDesc = {
	value: void 0,
	enumerable: false
};
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
	const E = _E;
	if (E) {
		const saved = E.stackTraceLimit;
		if (typeof saved === "number") {
			try {
				E.stackTraceLimit = 0;
			} catch {
				_E = null;
				return new Definition();
			}
			try {
				return new Definition();
			} finally {
				E.stackTraceLimit = saved;
			}
		}
	}
	return new Definition();
}
/* @__NO_SIDE_EFFECTS__ */
function $constructor(name, initializer, proto, params) {
	const zodProto = {};
	function Internals(def) {
		this.def = def;
		this.constr = _;
		this.traits = /* @__PURE__ */ new Set();
	}
	Internals.prototype = zodProto;
	const protoMembers = proto;
	const initialized = protoMembers && /* @__PURE__ */ new WeakSet();
	function init(inst, def) {
		if (!inst._zod) {
			_zodDesc.value = new Internals(def);
			try {
				Object.defineProperty(inst, "_zod", _zodDesc);
			} finally {
				_zodDesc.value = void 0;
			}
		} else if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		if (initialized) {
			const own = Object.getPrototypeOf(inst);
			const ctorProto = inst._zod.constr.prototype;
			let up = own;
			while (up && up !== ctorProto) up = Object.getPrototypeOf(up);
			const target = up ?? own;
			if (!initialized.has(target)) {
				initialized.add(target);
				members(target, protoMembers);
			}
		}
		const proto = _.prototype;
		for (const k in proto) {
			if (!Object.prototype.hasOwnProperty.call(proto, k)) continue;
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		const inst = params?.Parent ? newError(Definition) : this;
		init(inst, def);
		const deferred = inst._zod.deferred;
		if (deferred) {
			for (const fn of deferred) fn();
			inst._zod.deferred = void 0;
		}
		const pp = globalThis.__zod_globalConfig?.postProcessor;
		if (pp) pp(inst);
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/errors.js
function _getMessage() {
	const internals = this._zod;
	internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
	return internals.message;
}
function _setMessage(value) {
	this._zod.message = value;
}
var _messageDesc = {
	get: _getMessage,
	set: _setMessage,
	enumerable: true,
	configurable: true
};
var _issuesDesc = {
	value: void 0,
	enumerable: false
};
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	_issuesDesc.value = def;
	Object.defineProperty(inst, "issues", _issuesDesc);
	_issuesDesc.value = void 0;
	Object.defineProperty(inst, "message", _messageDesc);
	const proto = Object.getPrototypeOf(inst);
	if (!_installedToString.has(proto)) {
		_installedToString.add(proto);
		Object.defineProperty(proto, "toString", {
			configurable: true,
			enumerable: false,
			get() {
				const value = () => this.message;
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
				return value;
			},
			set(value) {
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
			}
		});
	}
};
var $ZodError = /* @__PURE__ */ $constructor("$ZodError", initializer$1);
/** Get-or-create `obj[key]` as an own data property. A path segment naming an inherited member
* ("toString", "constructor") would otherwise read through to the prototype, and assigning
* "__proto__" would hit the setter instead of creating a key. */
function node(obj, key, make) {
	if (!Object.prototype.hasOwnProperty.call(obj, key)) {
		if (key === "__proto__") Object.defineProperty(obj, key, {
			value: make(),
			writable: true,
			enumerable: true,
			configurable: true
		});
		else obj[key] = make();
	}
	return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
	else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error, path = []) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else {
			const fullpath = [...path, ...issue.path];
			if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < fullpath.length) {
					const el = fullpath[i];
					const terminal = i === fullpath.length - 1;
					if (el === "_errors") {
						if (terminal) curr._errors.push(mapper(issue));
						i++;
						continue;
					}
					if (!Object.prototype.hasOwnProperty.call(curr, el)) Object.defineProperty(curr, el, {
						value: { _errors: [] },
						enumerable: true,
						writable: true,
						configurable: true
					});
					const node = curr[el];
					if (terminal) node._errors.push(mapper(issue));
					curr = node;
					i++;
				}
			}
		}
	};
	processError(error);
	return fieldErrors;
}
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
	return {
		callee: params?.callee ?? callee,
		Err: params?.Err
	};
}
var _parse = (_Err) => {
	const fn = (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: false
		} : { async: false };
		const result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) throw new $ZodAsyncError();
		if (result.issues.length) {
			const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, _params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
var _parseAsync = (_Err) => {
	const fn = async (schema, value, _ctx, params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: true
		} : { async: true };
		let result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) result = await result;
		if (result.issues.length) {
			const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? failure(_Err, result.issues, ctx) : {
		success: true,
		data: result.value
	};
};
function failure(Err, issues, ctx) {
	let error;
	return {
		success: false,
		get error() {
			if (!error) {
				error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
				issues = void 0;
				ctx = void 0;
			}
			return error;
		},
		set error(e) {
			error = e;
			issues = void 0;
			ctx = void 0;
		}
	};
}
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? failure(_Err, result.issues, ctx) : {
		success: true,
		data: result.value
	};
};
var COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
var COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
var validate = ((schema, value, _ctx) => {
	const validator = schema._zod.bag.validator;
	if (validator !== void 0) {
		if (validator(value) !== COMPILE_INVALID) return true;
		if (validator.definite === true && _ctx === void 0) return false;
	}
	return validateFallback(schema, value, _ctx);
});
function validateFallback(schema, value, _ctx) {
	const ctx = _ctx ? {
		..._ctx,
		async: false,
		abortEarly: true
	} : {
		async: false,
		abortEarly: true
	};
	const fallbackRun = schema._zod.bag.fallbackRun;
	let result;
	if (fallbackRun) {
		ctx[COMPILE_FALLBACK] = true;
		result = fallbackRun({
			value,
			issues: []
		}, ctx);
	} else result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length === 0;
}
var validateAsync$1 = async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true,
		abortEarly: true
	} : {
		async: true,
		abortEarly: true
	};
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length === 0;
};
var _encode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return parse(schema, value, ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _decode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		return parse(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _encodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return await parseAsync(schema, value, ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _decodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/regexes.js
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
	return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
var uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
var email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji$1 = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
/** Anchors a pattern source. The interpolation lives here rather than at the call site because
* esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it
* will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */
function anchor(source) {
	return new RegExp(`^${source}$`);
}
var date = /*@__PURE__*/ anchor(dateSource);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
	const opts = ["Z"];
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const qualified = `${timeSource({
		precision: args.precision,
		seconds: true
	})}(?:${opts.join("|")})`;
	const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var anyString = /^[\s\S]{0,}$/;
var integer = /^-?\d+$/;
var number$2 = /^-?\d+(?:\.\d+)?$/;
var boolean$1 = /^(?:true|false)$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/checks.js
var $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
/** Default `when` for length-based checks: run only on non-nullish values with a `length`. */
var _whenHasLength = (payload) => {
	const val = payload.value;
	return !nullish(val) && val.length !== void 0;
};
var numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
var $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units > def.maximum ? codePointLength(input) : units) <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units) >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	def.pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = [], closed = {}) {
		this.content = [];
		this.indent = 0;
		this.args = args;
		this.closed = closed;
	}
	indented(fn) {
		this.indent += 1;
		try {
			fn(this);
		} finally {
			this.indent -= 1;
		}
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const content = this?.content ?? [``];
		return new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {\n${content.join("\n")}\n};`)(...Object.values(this.closed));
	}
};
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/versions.js
var version = {
	major: 4,
	minor: 6,
	patch: 7
};
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/schemas.js
var $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const defChecks = inst._zod.def.checks;
	const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			if (payload.memo) return payload;
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (explicitlyAborted(payload)) continue;
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
}, {
	get "~standard"() {
		return hide(this, "~standard", standardProps(this));
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	}
});
/** The Standard Schema surface for `inst`. Shared so wrappers can extend it without forcing it. */
var toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync(inst, value) {
	const ctx = { async: true };
	return toStandardResult(await inst._zod.run({
		value,
		issues: []
	}, ctx), ctx);
}
function standardProps(inst) {
	return {
		validate: (value) => {
			const ctx = { async: false };
			try {
				const r = inst._zod.run({
					value,
					issues: []
				}, ctx);
				if (!(r instanceof Promise)) return toStandardResult(r, ctx);
			} catch (_) {}
			return validateAsync(inst, value);
		},
		vendor: "zod",
		version: 1
	};
}
var $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = def.pattern ?? anyString;
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
var $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
var $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
var $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
var $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
function canParseURL(input) {
	try {
		if (typeof URL !== "undefined" && typeof URL.canParse === "function") return URL.canParse(input);
		new URL(input);
		return true;
	} catch {
		return false;
	}
}
function validateURL(trimmed, def) {
	if (!("normalize" in def) && !("hostname" in def) && !("protocol" in def)) return canParseURL(trimmed) || 2;
	return parseURLObject(trimmed, def);
}
/** Parses a URL while preserving the non-normalizing HTTP guard. */
function parseURLObject(trimmed, def) {
	if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) return 1;
	try {
		if (typeof URL !== "undefined") {
			const URLStatic = URL;
			if (typeof URLStatic.parse === "function") return URLStatic.parse(trimmed) ?? 2;
		}
		return new URL(trimmed);
	} catch {
		return 2;
	}
}
var asciiTabOrNewline = /[\t\n\r]/g;
/** The URL parser deletes every ASCII tab, LF and CR from its input before it parses, so `new URL("https://exa\nmple.com")` reports on `example.com`. Applying the same deletion to the returned value closes the half of that divergence which can move the host; the parser's other rewrite, stripping C0 controls at the edges, cannot. */
function stripTabAndNewline(value) {
	return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
	hostname.lastIndex = 0;
	return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
	protocol.lastIndex = 0;
	return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
var $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			const url = validateURL(trimmed, def);
			if (url === 1) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid URL format",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (url === 2) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (url === true) {
				payload.value = stripTabAndNewline(trimmed);
				return;
			}
			if (def.hostname && !urlHostnameOk(url, def.hostname)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid hostname",
				pattern: def.hostname.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			if (def.protocol && !urlProtocolOk(url, def.protocol)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid protocol",
				pattern: def.protocol.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
var $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
	if (def.length !== void 0 && (!Number.isInteger(def.length) || def.length < 1)) throw new Error(`Invalid nanoid length: ${def.length}`);
	def.pattern ?? (def.pattern = def.length === void 0 ? nanoid : nanoidOfLength(def.length));
	$ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
var $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
var $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime(def));
	$ZodStringFormat.init(inst, def);
});
var $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date);
	$ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time(def));
	$ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration);
	$ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
});
/** An IPv6 address is written with hex digits, colons and dots, and nothing else. The guard is what makes the check below an IPv6 check: `new URL("http://[...]")` parses an authority, not an address, so `@` and `\` re-delimit it and `"::@1\\"` validates against the host `0.0.0.1`. The URL parser also deletes ASCII tab, LF and CR rather than failing, which is how `"::1\n"` validated as `::1`. */
var ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
	if (!ipv6Alphabet.test(value)) return false;
	return canParseURL(`http://[${value}]`);
}
var $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (!isValidIPv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "ipv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
	const parts = value.split("/");
	if (parts.length !== 2) return false;
	const [address, prefix] = parts;
	if (!prefix) return false;
	const prefixNum = Number(prefix);
	if (`${prefixNum}` !== prefix) return false;
	if (prefixNum < 0 || prefixNum > 128) return false;
	return isValidIPv6(address);
}
var $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (!isValidCIDRv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "cidrv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (/\s/.test(data)) return false;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
var base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
var $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64Charset);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var base64urlCharset = /^[A-Za-z0-9_-]*$/;
function isValidBase64URL(data) {
	if (!base64urlCharset.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
var $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64urlCharset);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
var $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = number$2;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
var $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
var $ZodBoolean = /*@__PURE__*/ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
var $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
var $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function capSize(inst, size) {
	const caps = sizeCaps(inst._zod.def.checks);
	if (!caps.length) return;
	const cap = Math.min(...caps.map((c) => c[0]));
	const parse = inst._zod.parse;
	inst._zod.parse = (payload, ctx) => {
		const n = size(payload.value);
		if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
			for (const [max, ch] of sizeCaps(inst._zod.def.checks)) if (n > max && ch._zod.def.when(payload)) {
				const start = payload.issues.length;
				ch._zod.check(payload);
				payload.issues[start].continue = false;
				attachSchema(payload.issues, start, inst);
				return payload;
			}
		}
		return parse(payload, ctx);
	};
}
var arraySize = (input) => Array.isArray(input) ? input.length : -1;
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
var $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
		const proms = [];
		const abortEarly = ctx?.abortEarly;
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else {
				handleArrayResult(result, payload, i);
				if (abortEarly && result.issues.length !== 0 && aborted(result)) break;
			}
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
	capSize(inst, arraySize);
});
function handlePropertyResult(result, final, key, input, optin, optout) {
	const isPresent = key in input;
	const isOptionalOut = optout === "optional";
	if (!isPresent && isOptionalOut && optin === "optional") return;
	if (result.issues.length) {
		if (optin !== void 0 && isOptionalOut && !isPresent) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (!isPresent && optin === void 0) {
		if (!result.issues.length) final.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [key]
		});
		return;
	}
	if (result.value === void 0) {
		if (isPresent || optin === "defaulted" && !isOptionalOut) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	const ownSymbols = Object.getOwnPropertySymbols(def.shape);
	const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
	const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
	for (const k of allKeys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		allKeys,
		symbolKeys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const optin = _catchall.optin;
	const optout = _catchall.optout;
	let seen = 0;
	for (const key in input) {
		if (abortEarly && payload.issues.length !== seen) {
			if (aborted(payload, seen)) break;
			seen = payload.issues.length;
		}
		if (keySet.has(key)) continue;
		if (key === "__proto__") {
			if (t === "never") unrecognized.push(key);
			continue;
		}
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
		else handlePropertyResult(r, payload, key, input, optin, optout);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst,
		continue: true
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
var $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	const desc = Object.getOwnPropertyDescriptor(def, "shape");
	const sh = desc?.get ? desc.get.raw : def.shape ?? {};
	if (sh) {
		const get = () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			get.raw = newSh;
			return newSh;
		};
		get.raw = sh;
		Object.defineProperty(def, "shape", { get });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazyInternal(inst, "propValues", (zod) => {
		const shape = zod.def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				if (!Object.prototype.hasOwnProperty.call(propValues, key)) assignProp(propValues, key, /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
				if (field.optin !== void 0) propValues[key].add(void 0);
			}
		}
		return propValues;
	});
	const isObject$1 = isObject;
	const catchall = def.catchall;
	let value;
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
		const proms = [];
		const shape = value.shape;
		const abortEarly = ctx?.abortEarly;
		let seen = payload.issues.length;
		for (const key of value.allKeys) {
			if (abortEarly && payload.issues.length !== seen) {
				if (aborted(payload, seen)) break;
				seen = payload.issues.length;
			}
			if (key === "__proto__") continue;
			const el = shape[key];
			const optin = el._zod.optin;
			const optout = el._zod.optout;
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
			else handlePropertyResult(r, payload, key, input, optin, optout);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
	};
});
var $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const memo = globalConfig.memoizer;
	const generateFastpass = (shape) => {
		const normalized = _normalized.value;
		const syms = normalized.symbolKeys;
		const doc = new Doc(["payload", "ctx"], {
			shape,
			inst,
			memo,
			syms
		});
		const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.allKeys) ids[key] = `key_${counter++}`;
		doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
		for (const key of normalized.allKeys) {
			if (key === "__proto__") continue;
			const id = ids[key];
			const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
			const isPresent = `${k} in input`;
			const schema = shape[key];
			const optin = schema?._zod?.optin;
			const isOptionalIn = optin !== void 0;
			const isOptionalOut = schema?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(k)};`);
			if (isOptionalIn && isOptionalOut) {
				const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
				doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
			} else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
			else {
				doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
				if (optin === "defaulted") doc.write(`newResult[${k}] = ${id}.value;`);
				else doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
			}
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		return doc.compile();
	};
	let fastpass;
	const isObject$2 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
var $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== void 0) ? "optional" : void 0);
	defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazyInternal(inst, "values", (zod) => {
		if (zod.def.options.every((o) => o._zod.values)) return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		if (zod.def.options.every((o) => o._zod.pattern)) {
			const patterns = zod.def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const first = def.options.length === 1 ? def.options[0]._zod.run : null;
	inst._zod.parse = (payload, ctx) => {
		if (first) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
function discriminatorMap(def) {
	const map = /* @__PURE__ */ new Map();
	for (const option of def.options) {
		const values = option._zod.propValues?.[def.discriminator];
		if (!values || values.size === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
		for (const value of values) if (map.has(value)) {
			if (value !== void 0) throw new Error(`Duplicate discriminator value "${String(value)}"`);
			map.set(value, null);
		} else map.set(value, option);
	}
	return map;
}
var $ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
	def.inclusive = false;
	$ZodUnion.init(inst, def);
	const _super = inst._zod.parse;
	defineLazyInternal(inst, "propValues", (zod) => {
		const propValues = {};
		let undefinedCount = 0;
		for (const option of zod.def.options) {
			const pv = option._zod.propValues;
			if (!pv || Object.keys(pv).length === 0) throw new Error(`Invalid discriminated union option at index "${zod.def.options.indexOf(option)}"`);
			if (pv[zod.def.discriminator]?.has(void 0)) undefinedCount++;
			for (const [k, v] of Object.entries(pv)) {
				if (!Object.prototype.hasOwnProperty.call(propValues, k)) assignProp(propValues, k, /* @__PURE__ */ new Set());
				for (const val of v) propValues[k].add(val);
			}
		}
		if (!zod.def.unionFallback && undefinedCount > 1) propValues[zod.def.discriminator]?.delete(void 0);
		return propValues;
	});
	def.options.forEach((option, i) => {
		const propShape = rawShape(option._zod.def);
		if (propShape && !Object.prototype.hasOwnProperty.call(propShape, def.discriminator)) throw new Error(`Invalid discriminated union option at index "${i}"`);
	});
	const disc = cached(() => discriminatorMap(def));
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isObject(input)) {
			payload.issues.push({
				code: "invalid_type",
				expected: "object",
				input,
				inst
			});
			return payload;
		}
		const value = input?.[def.discriminator];
		const opt = disc.value.get(value);
		if (opt && (value !== void 0 || ctx.direction !== "backward")) return opt._zod.run(payload, ctx);
		if (def.unionFallback || ctx.direction === "backward") return _super(payload, ctx);
		payload.issues.push({
			code: "invalid_union",
			errors: [],
			note: "No matching discriminator",
			discriminator: def.discriminator,
			options: Array.from(disc.value.keys()).filter((value) => disc.value.get(value) !== null),
			input,
			path: [def.discriminator],
			inst
		});
		return payload;
	};
});
var $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		if (Object.prototype.hasOwnProperty.call(newObj, "__proto__")) delete newObj.__proto__;
		for (const key of sharedKeys) {
			if (key === "__proto__") continue;
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	const keyIssues = /* @__PURE__ */ new Map();
	const collect = (iss, side) => {
		let keys;
		if (iss.code === "unrecognized_keys" && !iss.path?.length) {
			unrecIssue ?? (unrecIssue = iss);
			keys = iss.keys;
		} else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
			const k = String(iss.path[0]);
			if (!keyIssues.has(k)) keyIssues.set(k, iss);
			keys = [k];
		} else return false;
		for (const k of keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k)[side] = true;
		}
		return true;
	};
	for (const iss of left.issues) if (!collect(iss, "l")) result.issues.push(iss);
	for (const iss of right.issues) if (!collect(iss, "r")) result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length) {
		const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
		if (aggregated.length) result.issues.push({
			...unrecIssue,
			keys: aggregated
		});
		for (const k of bothKeys) if (!aggregated.includes(k) && keyIssues.has(k)) result.issues.push(keyIssues.get(k));
	}
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) {
		if (aborted(result)) return result;
		throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	}
	result.value = merged.data;
	return result;
}
var $ZodRecord = /*@__PURE__*/ $constructor("$ZodRecord", (inst, def) => {
	$ZodType.init(inst, def);
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isPlainObject(input)) {
			payload.issues.push({
				expected: "record",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		const proms = [];
		const values = def.keyType._zod.values;
		if (values && !def.partial) {
			payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
			const recordKeys = /* @__PURE__ */ new Set();
			for (const key of values) if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
				recordKeys.add(typeof key === "number" ? key.toString() : key);
				if (key === "__proto__") continue;
				const keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (keyResult.issues.length) {
					payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const outKey = keyResult.value;
				if (outKey === "__proto__") continue;
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}
			}
			let unrecognized;
			for (const key in input) if (!recordKeys.has(key)) {
				if (def.mode === "loose") {
					if (key === "__proto__") continue;
					payload.value[key] = input[key];
				} else {
					unrecognized = unrecognized ?? [];
					unrecognized.push(key);
				}
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized,
				continue: true
			});
		} else {
			payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
			let unrecognized;
			for (const key of Reflect.ownKeys(input)) {
				if (key === "__proto__") continue;
				if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
				let keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (typeof key === "string" && number$2.test(key) && keyResult.issues.length) {
					const retryResult = def.keyType._zod.run({
						value: Number(key),
						issues: []
					}, ctx);
					if (retryResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (retryResult.issues.length === 0) keyResult = retryResult;
				}
				if (keyResult.issues.length) {
					if (def.mode === "loose") payload.value[key] = input[key];
					else if (values) {
						unrecognized = unrecognized ?? [];
						unrecognized.push(key);
					} else payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const outKey = keyResult.value;
				if (outKey === "__proto__") continue;
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized,
				continue: true
			});
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
var $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	defineLazyInternal(inst, "pattern", (zod) => {
		const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
		return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
	});
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
var $ZodLiteral = /*@__PURE__*/ $constructor("$ZodLiteral", (inst, def) => {
	$ZodType.init(inst, def);
	const values = new Set(def.values);
	inst._zod.values = values;
	defineLazyInternal(inst, "pattern", (zod) => {
		const vals = zod.def.values;
		return new RegExp(vals.length ? `^(${vals.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
	});
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (values.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values: def.values,
			input,
			inst
		});
		return payload;
	};
});
var $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	globalConfig.memoizer?.guard(inst);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		return payload;
	};
});
function handleOptionalResult(payload, result) {
	payload.value = result.issues.length ? void 0 : result.value;
	return payload;
}
var $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	inst._zod.optout = "optional";
	defineLazyInternal(inst, "values", (zod) => {
		const values = zod.def.innerType._zod.values;
		return values ? /* @__PURE__ */ new Set([...values, void 0]) : void 0;
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === void 0) {
			if (def.innerType._zod.optin !== "defaulted") return payload;
			const result = def.innerType._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) return result.then((result) => handleOptionalResult(payload, result));
			return handleOptionalResult(payload, result);
		}
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazyInternal(inst, "values", (zod) => {
		return zod.def.innerType._zod.values ? /* @__PURE__ */ new Set([...zod.def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
var $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => {
		const v = zod.def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
function handleCatchResult(payload, result, def, ctx) {
	if (!result.issues.length) {
		payload.value = result.value;
		if (result.memo) payload.memo = true;
		return payload;
	}
	payload.value = def.catchValue({
		...result,
		value: payload.value,
		error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
		input: payload.value
	});
	return payload;
}
var $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run({
			value: payload.value,
			issues: []
		}, ctx);
		if (result instanceof Promise) return result.then((result) => handleCatchResult(payload, result, def, ctx));
		return handleCatchResult(payload, result, def, ctx);
	};
});
var $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues
	}, ctx);
}
var $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	if (!payload.memo) payload.value = Object.freeze(payload.value);
	return payload;
}
var $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/memoizer.js
var $ZodCyclicError = class extends Error {
	constructor() {
		super(`Cannot parse a reference cycle that closes through a transform`);
		this.name = "ZodCyclicError";
	}
};
/** Keyed off the context object every schema in one parse call already shares. */
var STATE = "~memo";
var NO_ISSUES = [];
function isRef(value) {
	return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
	return issues.map((iss) => iss.path ? {
		...iss,
		path: iss.path.slice()
	} : { ...iss });
}
var recursive = /*@__PURE__*/ new WeakMap();
/** What the walk established, in order of certainty: ordered so the strongest answer among children wins. */
var NONE = 0;
var ASSUMED = 1;
var PROVEN = 2;
/** Whether this schema's subtree contains a cycle, so one parse can re-enter it. */
function isRecursive(inst, stack, resolve) {
	const cached = recursive.get(inst);
	if (cached !== void 0) return cached ? PROVEN : NONE;
	if (stack.has(inst)) return PROVEN;
	stack.add(inst);
	let result = NONE;
	const check = (child) => {
		if (result !== PROVEN && child?._zod) {
			const answer = isRecursive(child, stack, resolve);
			if (answer > result) result = answer;
		}
	};
	const shape = (sh, spread) => {
		let answer = NONE;
		for (const key of Reflect.ownKeys(sh)) {
			const desc = Object.getOwnPropertyDescriptor(sh, key);
			if (spread && !desc.enumerable) continue;
			const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve) : NONE;
			if (child > answer) answer = child;
		}
		return answer;
	};
	const merge = (answer) => {
		if (answer > result) result = answer;
	};
	const def = inst._zod.def;
	switch (def.type) {
		case "object": {
			const raw = rawShape(def);
			merge(raw ? shape(raw, true) : ASSUMED);
			check(def.catchall);
			break;
		}
		case "array":
			check(def.element);
			break;
		case "tuple":
			for (const el of def.items) check(el);
			check(def.rest);
			break;
		case "record":
		case "map":
			check(def.keyType);
			check(def.valueType);
			break;
		case "set":
			check(def.valueType);
			break;
		case "union":
			for (const el of def.options) check(el);
			break;
		case "intersection":
			check(def.left);
			check(def.right);
			break;
		case "optional":
		case "nullable":
		case "default":
		case "prefault":
		case "catch":
		case "readonly":
		case "nonoptional":
		case "promise":
		case "success":
			check(def.innerType);
			break;
		case "pipe":
			check(def.in);
			check(def.out);
			break;
		case "function":
			check(def.input);
			check(def.output);
			break;
		case "lazy": {
			const inner = def._cachedInner ?? (resolve ? inst._zod.innerType : void 0);
			merge(inner ? isRecursive(inner, stack, false) : ASSUMED);
			break;
		}
		case "template_literal":
		case "string":
		case "number":
		case "int":
		case "boolean":
		case "bigint":
		case "symbol":
		case "undefined":
		case "null":
		case "void":
		case "never":
		case "any":
		case "unknown":
		case "date":
		case "nan":
		case "enum":
		case "literal":
		case "file":
		case "transform":
		case "custom": break;
		default: for (const key in def) {
			const desc = Object.getOwnPropertyDescriptor(def, key);
			if (!desc || desc.get) continue;
			const value = desc.value;
			if (!value || typeof value !== "object") continue;
			if (value._zod) check(value);
			else if (Array.isArray(value)) for (const el of value) check(el);
		}
	}
	stack.delete(inst);
	return settle(inst, result);
}
/** An assumed answer must not outlive the resolution that settles it, so only a certain one is cached. */
function settle(inst, answer) {
	if (answer !== ASSUMED) recursive.set(inst, answer === PROVEN);
	return answer;
}
function bucketFor(state, inst) {
	let bucket = state.buckets.get(inst);
	if (!bucket) {
		bucket = /* @__PURE__ */ new WeakMap();
		state.buckets.set(inst, bucket);
	}
	return bucket;
}
var handoff;
var open$1 = [];
var memo = {
	alloc(_inst, payload, empty) {
		const bucket = handoff;
		if (!bucket) return empty;
		handoff = void 0;
		const entry = {
			value: empty,
			issues: null
		};
		bucket.set(payload.value, entry);
		open$1.push(entry);
		return empty;
	},
	guard(inst) {
		var _a;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value)) throw new $ZodCyclicError();
				return base(payload, ctx);
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	},
	attach(inst) {
		var _a;
		let isRecursiveInst;
		let rechecked = false;
		let lastCtx;
		let lastBucket;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (isRecursiveInst === void 0) {
					const walked = isRecursive(inst, /* @__PURE__ */ new Set(), false);
					if (walked === NONE) {
						inst._zod.parse = base;
						if (inst._zod.run === wrapped) inst._zod.run = base;
						return base(payload, ctx);
					}
					if (walked === PROVEN || rechecked) isRecursiveInst = true;
					else rechecked = true;
				}
				const input = payload.value;
				if (!isRef(input)) return base(payload, ctx);
				let state = ctx[STATE];
				if (!state) {
					state = {
						buckets: /* @__PURE__ */ new WeakMap(),
						backEdges: void 0
					};
					ctx[STATE] = state;
				}
				let bucket;
				if (lastCtx === ctx) bucket = lastBucket;
				else {
					bucket = bucketFor(state, inst);
					lastCtx = ctx;
					lastBucket = bucket;
				}
				const hit = bucket.get(input);
				if (hit) {
					payload.value = hit.value;
					if (hit.issues) {
						if (hit.issues.length) payload.issues.push(...cloneIssues(hit.issues));
					} else {
						payload.memo = true;
						state.backEdges ?? (state.backEdges = /* @__PURE__ */ new WeakSet());
						state.backEdges.add(hit.value);
					}
					return payload;
				}
				handoff = bucket;
				const depth = open$1.length;
				const result = base(payload, ctx);
				handoff = void 0;
				const entry = open$1.length > depth ? open$1.pop() : void 0;
				if (result instanceof Promise) return result.then((r) => {
					if (entry) entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
					return r;
				});
				if (entry) entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
				return result;
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	}
};
/** The memoizer that gives containers cycle support. `zod` installs it by default; `zod/mini` opts in with `config({ memoizer: memoizer() })`. */
function memoizer() {
	return memo;
}
/** Whether this value is a node a back-edge resolved to before it finished. */
function isBackEdge(ctx, value) {
	const backEdges = ctx[STATE]?.backEdges;
	return backEdges !== void 0 && isRef(value) && backEdges.has(value);
}
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/locales/en.js
var error = () => {
	const Sizable = {
		string: {
			unit: "characters",
			verb: "to have"
		},
		file: {
			unit: "bytes",
			verb: "to have"
		},
		array: {
			unit: "items",
			verb: "to have"
		},
		set: {
			unit: "items",
			verb: "to have"
		},
		map: {
			unit: "entries",
			verb: "to have"
		}
	};
	function getSizing(origin) {
		return Sizable[origin] ?? null;
	}
	const FormatDictionary = {
		regex: "input",
		email: "email address",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datetime",
		date: "ISO date",
		time: "ISO time",
		duration: "ISO duration",
		ipv4: "IPv4 address",
		ipv6: "IPv6 address",
		mac: "MAC address",
		cidrv4: "IPv4 range",
		cidrv6: "IPv6 range",
		base64: "base64-encoded string",
		base64url: "base64url-encoded string",
		json_string: "JSON string",
		e164: "E.164 number",
		currency_code: "currency code",
		credit_card: "credit card number",
		iban: "IBAN",
		jwt: "JWT",
		template_literal: "input"
	};
	const TypeDictionary = { nan: "NaN" };
	function getTypeName(type, input) {
		if (type === "number" && typeof input === "number" && !Number.isFinite(input)) return String(input);
		return TypeDictionary[type] ?? type;
	}
	return (issue) => {
		switch (issue.code) {
			case "invalid_type": return `Invalid input: expected ${getTypeName(issue.expected)}, received ${getTypeName(parsedType(issue.input), issue.input)}`;
			case "invalid_value":
				if (issue.values.length === 1) return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
				return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
			case "too_big": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
				return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
			}
			case "too_small": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
				return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
			}
			case "invalid_format": {
				const _issue = issue;
				if (_issue.format === "starts_with") return `Invalid string: must start with "${_issue.prefix}"`;
				if (_issue.format === "ends_with") return `Invalid string: must end with "${_issue.suffix}"`;
				if (_issue.format === "includes") return `Invalid string: must include "${_issue.includes}"`;
				if (_issue.format === "regex") return `Invalid string: must match pattern ${_issue.pattern}`;
				return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
			}
			case "not_multiple_of": return `Invalid number: must be a multiple of ${issue.divisor}`;
			case "unrecognized_keys": return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
			case "invalid_key": return `Invalid key in ${issue.origin}`;
			case "invalid_union":
				if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) return `Invalid discriminator value. Expected ${issue.options.map((o) => `'${o}'`).join(" | ")}`;
				if (issue.inclusive === false) return "Invalid input: more than one option matched";
				return "Invalid input";
			case "invalid_element": return `Invalid value in ${issue.origin}`;
			default: return `Invalid input`;
		}
	};
};
function en_default() {
	return { localeError: error() };
}
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
	if (def.checks) def.checks = [...def.checks];
	return def;
}
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
	return new Class(snapshotChecks({
		type: "string",
		...normalizeParams(params)
	}));
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link _cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
	return new Class(snapshotChecks({
		type: "number",
		checks: [],
		...normalizeParams(params)
	}));
}
// @__NO_SIDE_EFFECTS__
function _coercedNumber(Class, params) {
	return new Class(snapshotChecks({
		type: "number",
		coerce: true,
		checks: [],
		...normalizeParams(params)
	}));
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn, params) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	}, params);
	return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
	for (const source of sources) for (const key of Reflect.ownKeys(source)) if (Object.prototype.propertyIsEnumerable.call(source, key)) assignProp(target, key, source[key]);
	return target;
}
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		sharedDefsExtractedFor: void 0,
		sharedEmitDoneFor: void 0,
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		intersections: [],
		deferred: [],
		external: params?.external ?? void 0
	};
}
/**
* Applies the `unrepresentable` setting at a site that has no JSON Schema equivalent. Throws
* `message` unless the setting (or the handler's return value) says otherwise. Returns `true` if a
* custom JSON Schema was written into `json`, in which case the caller must not write its own.
*/
function handleUnrepresentable(schema, ctx, json, params, message) {
	const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({
		zodSchema: schema,
		path: params.path,
		message
	}) : ctx.unrepresentable;
	if (result === "any") return false;
	if (result === void 0 || result === "throw") throw new Error(message);
	Object.assign(json, result);
	return true;
}
function processSchema(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	ctx.sharedDefsExtractedFor = void 0;
	ctx.sharedEmitDoneFor = void 0;
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			processSchema(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) assignProps(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function encodeJSONPointerSegment(segment) {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external) return;
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}`
			};
		}
		const uriPrefix = `#`;
		const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
		if (entry[1] === root && !entry[1].schema.id) return { ref: uriPrefix };
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + encodeJSONPointerSegment(defId)
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") extractToDef(entry);
		}
	}
	if (ctx.external) ctx.sharedDefsExtractedFor = ctx.external;
}
/** Rewrites `anyOf: [{type: "a"}, {type: "b"}]` to `type: ["a", "b"]`, which every JSON Schema draft treats as equivalent and most consumers render far better for the nullable case. Only branches that are a bare type assertion qualify — anything carrying a constraint, `$ref`, `const` or metadata is left alone. Runs after `flattenRef`, so a branch an override decorated or `$defs` extraction turned into a `$ref` is no longer bare and correctly stays in `anyOf`. `oneOf` is excluded: `integer` and `number` overlap, so "exactly one" and "at least one" are not the same there. OpenAPI 3.0 is excluded: its `type` must be a single string. */
function compactTypeUnion(schema) {
	const options = schema.anyOf;
	if (!Array.isArray(options) || options.length === 0 || schema.type !== void 0) return;
	const types = [];
	for (const option of options) {
		if (!option || typeof option !== "object") return;
		compactTypeUnion(option);
		const keys = Object.keys(option);
		if (keys.length !== 1 || keys[0] !== "type") return;
		const type = option.type;
		for (const member of Array.isArray(type) ? type : [type]) {
			if (typeof member !== "string") return;
			if (!types.includes(member)) types.push(member);
		}
	}
	delete schema.anyOf;
	schema.type = types.length === 1 ? types[0] : types;
}
/** Keywords `foldIntersection` knows how to combine. Anything else — `$ref`, `patternProperties`,
* an annotation like `description` — makes a member unfoldable, so a constraint this does not
* understand leaves the `allOf` alone instead of being silently dropped or misattributed. */
var FOLDABLE_KEYS = /* @__PURE__ */ new Set([
	"type",
	"properties",
	"required",
	"additionalProperties"
]);
var UNION_KEYS = ["oneOf", "anyOf"];
/** A member's constraint on a key it does not declare itself. A `catchall` states one; `false`, an absent `additionalProperties`, and the empty schema a loose object emits state nothing. */
function undeclaredConstraint(member) {
	const extra = member.additionalProperties;
	if (extra === void 0 || extra === false || typeof extra !== "object" || extra === null) return null;
	return Object.keys(extra).length ? extra : null;
}
/** Combines object members into the single object they describe together, or returns `null` if any of them carries a keyword outside {@link FOLDABLE_KEYS}. */
function foldObjects(members) {
	const objects = [];
	for (const member of members) {
		if (typeof member !== "object" || member.type !== "object") return null;
		for (const key in member) if (!FOLDABLE_KEYS.has(key)) return null;
		objects.push(member);
	}
	const properties = {};
	const required = /* @__PURE__ */ new Set();
	for (const object of objects) {
		for (const key in object.properties) {
			if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
			const parts = [];
			for (const other of objects) {
				const part = other.properties?.[key] ?? undeclaredConstraint(other);
				if (part === null || part === void 0) continue;
				if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part))) parts.push(part);
			}
			assignProp(properties, key, parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts });
		}
		for (const key of object.required ?? []) required.add(key);
	}
	const folded = {
		type: "object",
		properties
	};
	if (required.size) folded.required = [...required];
	if (objects.every((object) => object.additionalProperties === false)) folded.additionalProperties = false;
	else {
		const constraints = [];
		for (const object of objects) {
			const constraint = undeclaredConstraint(object);
			if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint))) constraints.push(constraint);
		}
		if (constraints.length === 1) folded.additionalProperties = constraints[0];
		else if (constraints.length > 1) folded.additionalProperties = { allOf: constraints };
	}
	return folded;
}
/** `additionalProperties` in an `allOf` member sees only that member's own `properties`, so two
* closed object members reject each other's keys and the schema validates nothing. Zod's parser
* pools the key sets instead — `handleIntersectionResults` reports a key as unrecognized only when
* *every* side rejects it — so the emitted schema has to pool them too, and folding the members
* into one object is the encoding that says so on every target.
*
* This runs from `finalize`, after `extractDefs`, which is what keeps it clear of the `$ref`
* machinery: a member extracted into `$defs` is already a `$ref` by now and declines to fold, so it
* keeps its reference and its own closedness rather than being inlined as a stale copy. */
function foldIntersection(json) {
	const allOf = json.allOf;
	if (!Array.isArray(allOf) || allOf.length < 2) return;
	for (const key of FOLDABLE_KEYS) if (key in json) return;
	const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
	let folded = null;
	if (!unions.length) folded = foldObjects(allOf);
	else {
		const union = unions[0];
		const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
		if (Object.keys(union).length !== 1) return;
		const rest = allOf.filter((m) => m !== union);
		const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
		if (branches.some((b) => !b)) return;
		folded = { [keyword]: branches };
	}
	if (!folded) return;
	delete json.allOf;
	assignProps(json, folded);
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else assignProps(schema, refSchema);
			assignProps(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
		for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
		if (ctx.target !== "openapi-3.0") for (const entry of ctx.seen.entries()) compactTypeUnion(entry[1].def ?? entry[1].schema);
		for (const rewrite of ctx.deferred) rewrite();
		if (ctx.intersections.length) {
			const carriers = /* @__PURE__ */ new Map();
			for (const seen of ctx.seen.values()) for (const json of [seen.schema, seen.def]) {
				const allOf = json?.allOf;
				if (!Array.isArray(allOf)) continue;
				const existing = carriers.get(allOf);
				if (existing) existing.push(json);
				else carriers.set(allOf, [json]);
			}
			for (const allOf of ctx.intersections) for (const json of carriers.get(allOf) ?? []) foldIntersection(json);
		}
	}
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
	const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
	if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
	const defs = ctx.external?.defs ?? {};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) {
			if (seen.def.id === seen.defId) delete seen.def.id;
			assignProp(defs, seen.defId, seen.def);
		}
	}
	if (ctx.external) ctx.sharedEmitDoneFor = ctx.external;
	if (ctx.external) {} else if (Object.keys(defs).length > 0) {
		if (ctx.target === "draft-2020-12") result.$defs = defs;
		else result.definitions = defs;
	}
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") {
		if (_schema._zod.traits.has("$ZodCodec")) return true;
		return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	}
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	processSchema(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	processSchema(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/json-schema-processors.js
var narrowMin = (agg, key, value) => {
	if (agg[key] === void 0 || value > agg[key]) agg[key] = value;
};
var narrowMax = (agg, key, value) => {
	if (agg[key] === void 0 || value < agg[key]) agg[key] = value;
};
var narrowBoth = (agg, value) => {
	narrowMin(agg, "minimum", value);
	narrowMax(agg, "maximum", value);
};
var addDivisor = (agg, value) => {
	agg.multipleOf ?? (agg.multipleOf = []);
	if (!agg.multipleOf.includes(value)) agg.multipleOf.push(value);
};
var addPattern = (agg, pattern) => {
	agg.patterns ?? (agg.patterns = /* @__PURE__ */ new Set());
	agg.patterns.add(pattern);
};
var intersectMime = (agg, mime) => {
	agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
};
var setFormat = (agg, format) => {
	agg.format = format;
	if (format.includes("int")) agg.isInt = true;
};
var minContributor = (agg, def) => narrowMin(agg, "minimum", def.minimum);
var maxContributor = (agg, def) => narrowMax(agg, "maximum", def.maximum);
var formatContributor = (ranges) => (agg, def) => {
	setFormat(agg, def.format);
	const [minimum, maximum] = ranges[def.format];
	narrowMin(agg, "minimum", minimum);
	narrowMax(agg, "maximum", maximum);
};
var contributors = {
	greater_than: (agg, def) => narrowMin(agg, def.inclusive ? "minimum" : "exclusiveMinimum", def.value),
	less_than: (agg, def) => narrowMax(agg, def.inclusive ? "maximum" : "exclusiveMaximum", def.value),
	multiple_of: (agg, def) => addDivisor(agg, def.value),
	number_format: formatContributor(NUMBER_FORMAT_RANGES),
	bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
	min_length: minContributor,
	max_length: maxContributor,
	length_equals: (agg, def) => narrowBoth(agg, def.length),
	min_size: minContributor,
	max_size: maxContributor,
	size_equals: (agg, def) => narrowBoth(agg, def.size),
	string_format: (agg, def) => {
		setFormat(agg, def.format);
		if (def.pattern) addPattern(agg, def.pattern);
		if (def.format === "base64" || def.format === "base64url") agg.contentEncoding = def.format;
		if (def.local || def.precision === -1) agg.laxFormat = true;
	},
	mime_type: (agg, def) => intersectMime(agg, def.mime)
};
function aggregateChecks(schema) {
	const agg = {};
	const def = schema._zod.def;
	const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def.checks ?? []] : def.checks ?? [];
	for (const ch of list) contributors[ch._zod.def.check]?.(agg, ch._zod.def);
	const bag = schema._zod.bag;
	if (bag.minimum !== void 0) narrowMin(agg, "minimum", bag.minimum);
	if (bag.exclusiveMinimum !== void 0) narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
	if (bag.maximum !== void 0) narrowMax(agg, "maximum", bag.maximum);
	if (bag.exclusiveMaximum !== void 0) narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
	if (bag.multipleOf !== void 0) addDivisor(agg, bag.multipleOf);
	if (bag.format !== void 0) {
		agg.format ?? (agg.format = bag.format);
		if (bag.format.includes("int")) agg.isInt = true;
	}
	if (bag.mime) intersectMime(agg, bag.mime);
	for (const pattern of bag.patterns ?? []) addPattern(agg, pattern);
	return agg;
}
var formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
var exactPatterns = /* @__PURE__ */ new Map([[base64Charset, base64], [base64urlCharset, base64url]]);
var exactPattern = (p) => exactPatterns.get(p) ?? p;
var stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time" || laxFormat) delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const patternList = [...patterns].map(exactPattern);
		if (patternList.length === 1) json.pattern = patternList[0].source;
		else if (patternList.length > 1) json.allOf = [...patternList.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
var numberProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
	json.type = isInt ? "integer" : "number";
	const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
	const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
	const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
	if (exMin) {
		if (legacy) {
			json.minimum = exclusiveMinimum;
			json.exclusiveMinimum = true;
		} else json.exclusiveMinimum = exclusiveMinimum;
	} else if (typeof minimum === "number") json.minimum = minimum;
	if (exMax) {
		if (legacy) {
			json.maximum = exclusiveMaximum;
			json.exclusiveMaximum = true;
		} else json.exclusiveMaximum = exclusiveMaximum;
	} else if (typeof maximum === "number") json.maximum = maximum;
	if (multipleOf) {
		const divisors = /* @__PURE__ */ new Set();
		for (const divisor of multipleOf) if (Number.isFinite(divisor) && divisor !== 0) divisors.add(Math.abs(divisor));
		else handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
		const [first, ...rest] = divisors;
		if (first !== void 0) json.multipleOf = first;
		if (rest.length) json.allOf = [...json.allOf ?? [], ...rest.map((m) => ({ multipleOf: m }))];
	}
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
var neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
var enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.length === 0) {
		json.not = {};
		return;
	}
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
var literalProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	if (def.values.length === 0) {
		json.not = {};
		return;
	}
	const vals = [];
	for (const val of def.values) if (val === void 0) {
		if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema")) return;
	} else if (typeof val === "bigint") {
		if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema")) return;
		vals.push(Number(val));
	} else vals.push(val);
	if (vals.length === 0) {} else if (vals.length === 1) {
		const val = vals[0];
		json.type = val === null ? "null" : typeof val;
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
		else json.const = val;
	} else {
		if (vals.every((v) => typeof v === "number")) json.type = "number";
		if (vals.every((v) => typeof v === "string")) json.type = "string";
		if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
		if (vals.every((v) => v === null)) json.type = "null";
		json.enum = vals;
	}
};
var customProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
var transformProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
var arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = aggregateChecks(schema);
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = processSchema(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
function inputOptin(schema) {
	const def = schema._zod.def;
	if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) return inputOptin(def.out);
	if (def.type === "catch") return inputOptin(def.innerType);
	return schema._zod.optin;
}
var objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const shape = def.shape;
	if (Object.getOwnPropertySymbols(shape).length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) return;
	json.type = "object";
	json.properties = {};
	for (const key in shape) assignProp(json.properties, key, processSchema(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	}));
	const requiredKeys = [];
	for (const key of Object.keys(shape)) {
		const field = def.shape[key];
		if (ctx.io === "input" ? inputOptin(field) === void 0 : field._zod.optout === void 0) requiredKeys.push(key);
	}
	if (requiredKeys.length > 0) json.required = requiredKeys;
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = processSchema(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
var unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => processSchema(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
var intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = processSchema(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = processSchema(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	const allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
	json.allOf = allOf;
	ctx.intersections.push(allOf);
};
/** JSON object keys are always strings, so a numeric record key schema is re-expressed over the
* numeric-string form the record parser matches. Deferred to `finalize`, after the flatten: a key
* behind a wrapper only carries its own `type` before then, and a union key only has its branches.
*
* A numeric bound cannot apply to a property name, so `minimum` and its siblings are dropped rather
* than carried over: keeping them beside `type: "string"` reproduces the match-nothing schema this
* exists to fix. A key that carries one therefore emits wider than the record parses — `z.record(z.number().min(5), V)`
* accepts `"3"` — which is the deliberate trade, since throwing on it would reject an ordinary schema
* outright. */
function stringifyKeyNames(bySchema, json, visited) {
	if (json.$ref) {
		if (visited.has(json)) return json;
		visited.add(json);
		const def = bySchema.get(json)?.def;
		if (!def) return json;
		const inlined = stringifyKeyNames(bySchema, def, visited);
		return inlined === def ? json : inlined;
	}
	for (const keyword of ["anyOf", "oneOf"]) {
		const branches = json[keyword];
		if (!Array.isArray(branches)) continue;
		const mapped = branches.map((branch) => stringifyKeyNames(bySchema, branch, visited));
		if (mapped.some((branch, i) => branch !== branches[i])) json = {
			...json,
			[keyword]: mapped
		};
	}
	const types = Array.isArray(json.type) ? json.type : [json.type];
	const numericType = !types.includes("string") && types.some((t) => t === "number" || t === "integer");
	const values = json.enum ?? (json.const !== void 0 ? [json.const] : void 0);
	if (!numericType && !values?.some((v) => typeof v === "number")) return json;
	const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format, id, ...rest } = json;
	if (rest.enum) rest.enum = rest.enum.map((v) => typeof v === "number" ? String(v) : v);
	else if (typeof rest.const === "number") rest.const = String(rest.const);
	if (!numericType) return rest;
	rest.type = "string";
	if (!values) rest.pattern = (types.includes("number") ? number$2 : integer).source;
	return rest;
}
/** Every record of one conversion, so the carriers are found in a single pass rather than once per record. */
var pendingRecords = /* @__PURE__ */ new WeakMap();
function rewriteKeyNames(ctx) {
	const bySchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.values()) if (entry.def && !bySchema.has(entry.schema)) bySchema.set(entry.schema, entry);
	const rewrites = /* @__PURE__ */ new Map();
	for (const record of pendingRecords.get(ctx) ?? []) {
		const seen = ctx.seen.get(record);
		const names = (seen?.def ?? seen?.schema)?.propertyNames;
		if (!names || names === true || rewrites.has(names)) continue;
		const rewritten = stringifyKeyNames(bySchema, names, /* @__PURE__ */ new Set());
		if (rewritten !== names) rewrites.set(names, rewritten);
	}
	if (!rewrites.size) return;
	for (const entry of ctx.seen.values()) for (const carrier of [entry.schema, entry.def]) {
		const rewritten = carrier && rewrites.get(carrier.propertyNames);
		if (rewritten) carrier.propertyNames = rewritten;
	}
}
var recordProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	const keyType = def.keyType;
	const patterns = aggregateChecks(keyType).patterns;
	if (def.mode === "loose" && patterns && patterns.size > 0) {
		const valueSchema = processSchema(def.valueType, ctx, {
			...params,
			path: [
				...params.path,
				"patternProperties",
				"*"
			]
		});
		json.patternProperties = {};
		for (const pattern of patterns) assignProp(json.patternProperties, exactPattern(pattern).source, valueSchema);
	} else {
		if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
			json.propertyNames = processSchema(def.keyType, ctx, {
				...params,
				path: [...params.path, "propertyNames"]
			});
			let pending = pendingRecords.get(ctx);
			if (!pending) {
				pending = [];
				pendingRecords.set(ctx, pending);
				ctx.deferred.push(() => rewriteKeyNames(ctx));
			}
			pending.push(schema);
		}
		json.additionalProperties = processSchema(def.valueType, ctx, {
			...params,
			path: [...params.path, "additionalProperties"]
		});
	}
	const keyValues = keyType._zod.values;
	const omittableOnInput = ctx.io === "input" && inputOptin(def.valueType) !== void 0;
	if (keyValues && !def.partial && !omittableOnInput) {
		const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
		if (validKeyValues.length > 0) json.required = validKeyValues.map(String);
	}
};
var nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
/** Round-trips a default value through JSON so the emitted schema is guaranteed to be valid JSON.
* A BigInt has no reliable encoding, so it goes through `unrepresentable` like any other
* unrepresentable value. Returns a sentinel when the caller must not write a default of its own. */
var UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
	let unrepresentable = false;
	const serialized = JSON.stringify(value, (_, val) => {
		if (typeof val !== "bigint") return val;
		unrepresentable = true;
		return null;
	});
	if (!unrepresentable) return JSON.parse(serialized);
	handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
	return UNREPRESENTABLE_DEFAULT;
}
var defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json.default = value;
};
var prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io !== "input") return;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json._prefault = value;
};
var catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
		return;
	}
	json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const inIsTransform = def.in._zod.traits.has("$ZodTransform");
	const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
	processSchema(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/classic/errors.js
var _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
	Object.defineProperty(proto, key, {
		configurable: true,
		enumerable: false,
		get() {
			const value = make(this);
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
			return value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
		}
	});
}
var initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	const proto = Object.getPrototypeOf(inst);
	if (_installedErrorProtos.has(proto)) return;
	_installedErrorProtos.add(proto);
	_lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
	_lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
	_lazyMethod(proto, "addIssue", (self) => (issue) => {
		self.issues.push(issue);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	_lazyMethod(proto, "addIssues", (self) => (issues) => {
		self.issues.push(...issues);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	Object.defineProperty(proto, "isEmpty", {
		configurable: true,
		enumerable: false,
		get() {
			return this.issues.length === 0;
		}
	});
};
var ZodRealError = /*@__PURE__*/ $constructor("ZodError", initializer, void 0, { Parent: Error });
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/classic/parse.js
var parse = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode$1 = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
	if (!globalConfig.localeError) config(en_default());
}
function _ensureDefaultMemoizer() {
	if (!globalConfig.memoizer) config({ memoizer: memoizer() });
}
var ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
	_ensureDefaultLocale();
	$ZodType.init(inst, def);
	inst.def = def;
	inst.type = def.type;
	return inst;
}, {
	check(...chks) {
		const def = this.def;
		return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
			check: ch,
			def: { check: "custom" },
			onattach: []
		} } : ch)] }), { parent: true });
	},
	with(...chks) {
		return this.check(...chks);
	},
	clone(def, params) {
		return clone(this, def, params);
	},
	brand() {
		return this;
	},
	register(reg, meta) {
		reg.add(this, meta);
		return this;
	},
	refine(check, params) {
		return this.check(refine(check, params));
	},
	superRefine(refinement, params) {
		return this.check(superRefine(refinement, params));
	},
	overwrite(fn) {
		return this.check(/* @__PURE__ */ _overwrite(fn));
	},
	optional() {
		return optional(this);
	},
	exactOptional() {
		return exactOptional(this);
	},
	nullable() {
		return nullable(this);
	},
	nullish() {
		return optional(nullable(this));
	},
	nonoptional(params) {
		return nonoptional(this, params);
	},
	array() {
		return array(this);
	},
	or(arg) {
		return union([this, arg]);
	},
	and(arg) {
		return intersection(this, arg);
	},
	transform(tx) {
		return pipe(this, transform(tx));
	},
	default(d) {
		return _default(this, d);
	},
	prefault(d) {
		return prefault(this, d);
	},
	catch(params) {
		return _catch(this, params);
	},
	pipe(target) {
		return pipe(this, target);
	},
	readonly() {
		return readonly(this);
	},
	describe(description) {
		const cl = this.clone();
		globalRegistry.add(cl, { description });
		return cl;
	},
	meta(...args) {
		if (args.length === 0) return globalRegistry.get(this);
		const cl = this.clone();
		globalRegistry.add(cl, args[0]);
		return cl;
	},
	isOptional() {
		return this.safeParse(void 0).success;
	},
	isNullable() {
		return this.safeParse(null).success;
	},
	apply(fn, ...args) {
		return args.length === 0 ? fn(this) : fn(this, ...args);
	},
	get "~standard"() {
		return hide(this, "~standard", {
			...standardProps(this),
			jsonSchema: {
				input: createStandardJSONSchemaMethod(this, "input"),
				output: createStandardJSONSchemaMethod(this, "output")
			}
		});
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	},
	parse: function _parse(data, params) {
		return parse(this, data, params, { callee: _parse });
	},
	parseAsync: async function _parseAsync(data, params) {
		return await parseAsync(this, data, params, { callee: _parseAsync });
	},
	safeParse(data, params) {
		return safeParse(this, data, params);
	},
	async safeParseAsync(data, params) {
		return safeParseAsync(this, data, params);
	},
	get spa() {
		return this?.safeParseAsync;
	},
	set spa(value) {
		own(this, "spa", value);
	},
	validate(data, params) {
		return validate(this, data, params);
	},
	validateAsync(data, params) {
		return validateAsync$1(this, data, params);
	},
	encode: function _encode(data, params) {
		return encode(this, data, params, { callee: _encode });
	},
	decode: function _decode(data, params) {
		return decode$1(this, data, params, { callee: _decode });
	},
	encodeAsync: async function _encodeAsync(data, params) {
		return await encodeAsync(this, data, params, { callee: _encodeAsync });
	},
	decodeAsync: async function _decodeAsync(data, params) {
		return await decodeAsync(this, data, params, { callee: _decodeAsync });
	},
	safeEncode(data, params) {
		return safeEncode(this, data, params);
	},
	safeDecode(data, params) {
		return safeDecode(this, data, params);
	},
	async safeEncodeAsync(data, params) {
		return safeEncodeAsync(this, data, params);
	},
	async safeDecodeAsync(data, params) {
		return safeDecodeAsync(this, data, params);
	},
	toJSONSchema(params) {
		return createToJSONSchemaMethod(this, {})(params);
	},
	get description() {
		return globalRegistry.get(this)?.description;
	},
	get _def() {
		return this._zod.def;
	}
});
/** @internal */
var _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
}, /*@__PURE__*/ derived({
	format: (inst) => aggregateChecks(inst).format ?? null,
	minLength: (inst) => aggregateChecks(inst).minimum ?? null,
	maxLength: (inst) => aggregateChecks(inst).maximum ?? null
}, {
	regex(...args) {
		return this.check(/* @__PURE__ */ _regex(...args));
	},
	includes(...args) {
		return this.check(/* @__PURE__ */ _includes(...args));
	},
	startsWith(...args) {
		return this.check(/* @__PURE__ */ _startsWith(...args));
	},
	endsWith(...args) {
		return this.check(/* @__PURE__ */ _endsWith(...args));
	},
	min(...args) {
		return this.check(/* @__PURE__ */ _minLength(...args));
	},
	max(...args) {
		return this.check(/* @__PURE__ */ _maxLength(...args));
	},
	length(...args) {
		return this.check(/* @__PURE__ */ _length(...args));
	},
	nonempty(...args) {
		return this.check(/* @__PURE__ */ _minLength(1, ...args));
	},
	lowercase(params) {
		return this.check(/* @__PURE__ */ _lowercase(params));
	},
	uppercase(params) {
		return this.check(/* @__PURE__ */ _uppercase(params));
	},
	trim() {
		return this.check(/* @__PURE__ */ _trim());
	},
	normalize(...args) {
		return this.check(/* @__PURE__ */ _normalize(...args));
	},
	toLowerCase() {
		return this.check(/* @__PURE__ */ _toLowerCase());
	},
	toUpperCase() {
		return this.check(/* @__PURE__ */ _toUpperCase());
	},
	slugify() {
		return this.check(/* @__PURE__ */ _slugify());
	}
}));
var ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
}, {
	email(params) {
		return this.check(/* @__PURE__ */ _email(ZodEmail, params));
	},
	url(params) {
		return this.check(/* @__PURE__ */ _url(ZodURL, params));
	},
	jwt(params) {
		return this.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	},
	emoji(params) {
		return this.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	},
	guid(params) {
		return this.check(/* @__PURE__ */ _guid(ZodGUID, params));
	},
	uuid(params) {
		return this.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	},
	uuidv4(params) {
		return this.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	},
	uuidv6(params) {
		return this.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	},
	uuidv7(params) {
		return this.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	},
	nanoid(params) {
		return this.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	},
	cuid(params) {
		return this.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	},
	cuid2(params) {
		return this.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	},
	ulid(params) {
		return this.check(/* @__PURE__ */ _ulid(ZodULID, params));
	},
	base64(params) {
		return this.check(/* @__PURE__ */ _base64(ZodBase64, params));
	},
	base64url(params) {
		return this.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	},
	xid(params) {
		return this.check(/* @__PURE__ */ _xid(ZodXID, params));
	},
	ksuid(params) {
		return this.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	},
	ipv4(params) {
		return this.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	},
	ipv6(params) {
		return this.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	},
	cidrv4(params) {
		return this.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	},
	cidrv6(params) {
		return this.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	},
	e164(params) {
		return this.check(/* @__PURE__ */ _e164(ZodE164, params));
	},
	datetime(params) {
		return this.check(/* @__PURE__ */ _isoDateTime(ZodISODateTime, params));
	},
	date(params) {
		return this.check(/* @__PURE__ */ _isoDate(ZodISODate, params));
	},
	time(params) {
		return this.check(/* @__PURE__ */ _isoTime(ZodISOTime, params));
	},
	duration(params) {
		return this.check(/* @__PURE__ */ _isoDuration(ZodISODuration, params));
	}
});
function string(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
var ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
var ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	inst.isFinite = true;
}, /*@__PURE__*/ derived({
	minValue: (inst) => {
		const { minimum, exclusiveMinimum } = aggregateChecks(inst);
		return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
	},
	maxValue: (inst) => {
		const { maximum, exclusiveMaximum } = aggregateChecks(inst);
		return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
	},
	isInt: (inst) => {
		const { isInt, multipleOf } = aggregateChecks(inst);
		return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
	},
	format: (inst) => aggregateChecks(inst).format ?? null
}, {
	gt(value, params) {
		return this.check(/* @__PURE__ */ _gt(value, params));
	},
	gte(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	min(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	lt(value, params) {
		return this.check(/* @__PURE__ */ _lt(value, params));
	},
	lte(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	max(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	int(params) {
		return this.check(int(params));
	},
	safe(params) {
		return this.check(int(params));
	},
	positive(params) {
		return this.check(/* @__PURE__ */ _gt(0, params));
	},
	nonnegative(params) {
		return this.check(/* @__PURE__ */ _gte(0, params));
	},
	negative(params) {
		return this.check(/* @__PURE__ */ _lt(0, params));
	},
	nonpositive(params) {
		return this.check(/* @__PURE__ */ _lte(0, params));
	},
	multipleOf(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	step(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	finite() {
		return this;
	}
}));
function number$1(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
var ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
var ZodBoolean = /*@__PURE__*/ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
var ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
var ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
var ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
}, {
	min(n, params) {
		return this.check(/* @__PURE__ */ _minLength(n, params));
	},
	nonempty(params) {
		return this.check(/* @__PURE__ */ _minLength(1, params));
	},
	max(n, params) {
		return this.check(/* @__PURE__ */ _maxLength(n, params));
	},
	length(n, params) {
		return this.check(/* @__PURE__ */ _length(n, params));
	},
	unwrap() {
		return this.element;
	}
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
var ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
}, {
	keyof() {
		return _enum(Object.keys(this._zod.def.shape));
	},
	catchall(catchall) {
		return this.clone(mergeDefs(this._zod.def, { catchall }));
	},
	passthrough() {
		return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
	},
	loose() {
		return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
	},
	strict() {
		return this.clone(mergeDefs(this._zod.def, { catchall: never() }));
	},
	strip() {
		return this.clone(mergeDefs(this._zod.def, { catchall: void 0 }));
	},
	extend(incoming) {
		return extend(this, incoming);
	},
	safeExtend(incoming) {
		return safeExtend(this, incoming);
	},
	merge(other) {
		return merge(this, other);
	},
	pick(mask) {
		return pick(this, mask);
	},
	omit(mask) {
		return omit(this, mask);
	},
	partial(...args) {
		return partial(ZodOptional, this, args[0]);
	},
	exactPartial(...args) {
		return partial(ZodExactOptional, this, args[0], "exactPartial");
	},
	required(...args) {
		return required$1(ZodNonOptional, this, args[0]);
	}
});
function object(shape, params) {
	return new ZodObject({
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	});
}
var ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
var ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("ZodDiscriminatedUnion", (inst, def) => {
	ZodUnion.init(inst, def);
	$ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
	return new ZodDiscriminatedUnion({
		type: "union",
		options,
		discriminator,
		...normalizeParams(params)
	});
}
var ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
var ZodRecord = /*@__PURE__*/ $constructor("ZodRecord", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodRecord.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
	inst.keyType = def.keyType;
	inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
	if (!valueType || !valueType._zod) return new ZodRecord({
		type: "record",
		keyType: string(),
		valueType: keyType,
		...normalizeParams(valueType)
	});
	return new ZodRecord({
		type: "record",
		keyType,
		valueType,
		...normalizeParams(params)
	});
}
var ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = [...inst._zod.values];
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	return new ZodEnum({
		type: "enum",
		entries: Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values,
		...normalizeParams(params)
	});
}
var ZodLiteral = /*@__PURE__*/ $constructor("ZodLiteral", (inst, def) => {
	$ZodLiteral.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
	inst.values = new Set(def.values);
	Object.defineProperty(inst, "value", { get() {
		if (def.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
		return def.values[0];
	} });
});
function literal(value, params) {
	return new ZodLiteral({
		type: "literal",
		values: Array.isArray(value) ? value : [value],
		...normalizeParams(params)
	});
}
var ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			return payload;
		});
		payload.value = output;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
var ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
var ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
var ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
var ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
var ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
var ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
var ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
	});
}
var ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
var ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
var ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
	return /* @__PURE__ */ _superRefine(fn, params);
}
// node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/classic/coerce.js
function number(params) {
	return /* @__PURE__ */ _coercedNumber(ZodNumber, params);
}
// node_modules/.pnpm/@intentic+sandbox-contract@1.430.0/node_modules/@intentic/sandbox-contract/dist/time/zone.js
var isZone = (value) => {
	if (value.startsWith("+") || value.startsWith("-")) return false;
	try {
		return Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone !== "";
	} catch {
		return false;
	}
};
var asZone = (value) => value !== void 0 && isZone(value) ? value : void 0;
string().refine(isZone, { message: "Not a zone name ICU knows, e.g. Europe/Warsaw or UTC." });
string().regex(/^\d{4}-\d{2}-\d{2}$/, "A calendar day as YYYY-MM-DD.");
var civilDayIn = (at, zone) => new Intl.DateTimeFormat("en-CA", {
	timeZone: zone,
	year: "numeric",
	month: "2-digit",
	day: "2-digit"
}).format(at);
// node_modules/.pnpm/@intentic+constants@1.430.0/node_modules/@intentic/constants/dist/hosted-tiers.js
var HOSTED_TIERS = [
	{
		id: "free",
		name: "Free",
		cpuKind: "shared",
		cpus: 4,
		memoryMb: 4096,
		volumeGb: 10,
		monthlyHours: 40,
		priceUsd: 0,
		flyHourUsd: .0329
	},
	{
		id: "standard",
		name: "Standard",
		cpuKind: "shared",
		cpus: 8,
		memoryMb: 8192,
		volumeGb: 25,
		monthlyHours: 220,
		priceUsd: 20,
		flyHourUsd: .0657
	},
	{
		id: "max",
		name: "Max",
		cpuKind: "shared",
		cpus: 8,
		memoryMb: 16384,
		volumeGb: 50,
		monthlyHours: 320,
		priceUsd: 50,
		flyHourUsd: .1234
	}
];
HOSTED_TIERS[0];
HOSTED_TIERS.filter((tier) => tier.priceUsd > 0);
// node_modules/.pnpm/@intentic+constants@1.430.0/node_modules/@intentic/constants/dist/one-liner.js
var SETUP_CODE_PATTERN = /^[A-Za-z0-9]{6,64}$/;
var SYNC_LEAF_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
var FIX_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
var SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
var IMAGE_HASH_PATTERN = /^[a-f0-9]{8,64}$/;
var SHORT_CODE_PATTERN = /^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/;
var HOSTNAME_PATTERN = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
var DEFAULT_SYNC_ROOT = "~/intentic";
var isOneLinerHost = (host) => HOSTNAME_PATTERN.test(host) && !/^\d+$/.test(host.slice(host.lastIndexOf(".") + 1));
var arg = (name, pattern, normalize) => ({
	name,
	test: (value) => pattern.test(value),
	...normalize === void 0 ? {} : { normalize }
});
var slug = arg(`sandbox name`, SLUG_PATTERN);
var host = {
	name: `sandbox address`,
	test: isOneLinerHost,
	normalize: (value) => value.toLowerCase()
};
var shortCode = arg(`code`, SHORT_CODE_PATTERN);
var RECREATE = {
	sh: `recreate.sh`,
	ps1: `recreate.ps1`
};
var coded = (sh, ps1) => ({
	files: {
		sh,
		ps1
	},
	required: [host, shortCode],
	optional: [],
	sh: ([address = ``, code = ``]) => ({ args: [address, code] }),
	ps1: ([address = ``, code = ``]) => [{
		name: `Sandbox`,
		value: address
	}, {
		name: `Code`,
		value: code
	}]
});
var VERBS = {
	setup: {
		files: {
			sh: `connect.sh`,
			ps1: `connect.ps1`
		},
		required: [arg(`setup code`, SETUP_CODE_PATTERN)],
		optional: [arg(`sync folder`, SYNC_LEAF_PATTERN)],
		sh: ([code = ``, leaf]) => ({
			args: [code],
			env: leaf === void 0 ? [] : [[`SYNC_DIR`, `${DEFAULT_SYNC_ROOT}/${leaf}`]]
		}),
		ps1: ([code = ``, leaf]) => [{
			name: `SetupCode`,
			value: code
		}, ...leaf === void 0 ? [] : [{
			name: `SyncDir`,
			value: `${DEFAULT_SYNC_ROOT}/${leaf}`
		}]]
	},
	fix: {
		files: {
			sh: `fix.sh`,
			ps1: `fix.ps1`
		},
		required: [arg(`fix code`, FIX_CODE_PATTERN)],
		optional: [],
		sh: ([code = ``]) => ({ args: [code] }),
		ps1: ([code = ``]) => [{
			name: `Code`,
			value: code
		}]
	},
	update: {
		files: RECREATE,
		required: [slug],
		optional: [],
		sh: ([name = ``]) => ({ args: [name] }),
		ps1: ([name = ``]) => [{
			name: `Slug`,
			value: name
		}]
	},
	rollback: {
		files: RECREATE,
		required: [slug],
		optional: [],
		sh: ([name = ``]) => ({ args: [name, `--rollback`] }),
		ps1: ([name = ``]) => [{
			name: `Slug`,
			value: name
		}, { name: `Rollback` }]
	},
	restart: {
		files: RECREATE,
		required: [slug],
		optional: [],
		sh: ([name = ``]) => ({ args: [name, `--restart`] }),
		ps1: ([name = ``]) => [{
			name: `Slug`,
			value: name
		}, { name: `Restart` }]
	},
	rebuild: {
		files: RECREATE,
		required: [slug, arg(`image hash`, IMAGE_HASH_PATTERN)],
		optional: [],
		sh: ([name = ``, hash = ``]) => ({ args: [name, hash] }),
		ps1: ([name = ``, hash = ``]) => [{
			name: `Slug`,
			value: name
		}, {
			name: `Hash`,
			value: hash
		}]
	},
	remove: {
		files: {
			sh: `cleanup.sh`,
			ps1: `cleanup.ps1`
		},
		required: [],
		optional: [slug],
		sh: ([name]) => ({ args: name === void 0 ? [] : [name, `--yes`] }),
		ps1: ([name]) => name === void 0 ? [] : [{
			name: `Slug`,
			value: name
		}, { name: `Yes` }]
	},
	uninstall: {
		files: {
			sh: `uninstall.sh`,
			ps1: `uninstall.ps1`
		},
		required: [],
		optional: [],
		typed: true,
		sh: () => ({ args: [] }),
		ps1: () => []
	},
	device: coded(`device.sh`, `device.ps1`),
	sync: coded(`sync.sh`, `sync.ps1`)
};
Object.keys(VERBS);
// node_modules/.pnpm/@intentic+constants@1.430.0/node_modules/@intentic/constants/dist/index.js
var STATE_DIR = ".intentic";
// node_modules/.pnpm/@intentic+sandbox-contract@1.430.0/node_modules/@intentic/sandbox-contract/dist/schemas/device-artifacts.js
var ARTIFACT_CHUNK_BYTES = 2097152;
var ARTIFACT_MAX_BYTES = 4294967296;
var Sha256Schema = string().regex(/^[0-9a-f]{64}$/, "a lowercase hex sha256");
var ArtifactNameSchema = string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, dot, dash and underscore, starting with a letter or digit, at most 64");
var ArtifactFileNameSchema = string().regex(/^[A-Za-z0-9 ._()+-]{1,200}$/, "a plain file name").refine((name) => name !== "." && name !== ".." && !name.endsWith(".") && !name.endsWith(" "), "a plain file name");
var ArtifactKindSchema = _enum(["file", "tar"]);
var UploadIdSchema = string().regex(/^[0-9a-f]{32}$/);
discriminatedUnion("op", [
	object({
		op: literal("have"),
		name: ArtifactNameSchema,
		sha256: Sha256Schema,
		kind: ArtifactKindSchema,
		fileName: ArtifactFileNameSchema
	}).strict(),
	object({
		op: literal("chunk"),
		upload: UploadIdSchema,
		offset: int().nonnegative(),
		data: string().max(Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4)
	}).strict(),
	object({
		op: literal("commit"),
		upload: UploadIdSchema,
		name: ArtifactNameSchema,
		kind: ArtifactKindSchema,
		fileName: ArtifactFileNameSchema,
		size: int().nonnegative().max(ARTIFACT_MAX_BYTES),
		sha256: Sha256Schema
	}).strict(),
	object({
		op: literal("abort"),
		upload: UploadIdSchema
	}).strict()
]);
object({
	path: string().optional(),
	received: int().nonnegative().optional()
});
object({
	device: string(),
	path: string(),
	size: int().nonnegative(),
	sha256: Sha256Schema,
	reused: boolean()
});
var DialHostSchema = string().min(1).max(253).regex(/^[A-Za-z0-9._:-]+$/, "a hostname or an address: letters, digits, dots, dashes, underscores and colons");
object({
	ticket: string().regex(/^[0-9a-f]{48}$/),
	port: int().min(1).max(65535),
	host: DialHostSchema.optional()
}).strict();
object({
	device: string(),
	host: string().optional(),
	devicePort: int().min(1).max(65535),
	localPort: int().min(1).max(65535),
	url: string(),
	openedAt: string(),
	failure: string().optional()
});
var ROOT_PROJECT_PATHS = [`${STATE_DIR}/run.json`, `${STATE_DIR}/heavy.json`];
var RepoPathSchema = string().min(1).max(500).refine((path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."), "a path inside the repository, relative to its root");
var BundleNameSchema = string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199}(\/[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199})*$/, "a relative name, folders by /");
var SANDBOX_TARGET_NAME = /^[a-z][a-z0-9-]{0,39}$/;
var RunTargetSchema = object({
	name: ArtifactNameSchema,
	description: string().max(300).optional(),
	command: string().min(1).max(4e3).optional(),
	device: string().min(1).max(100).optional(),
	build: string().min(1).max(4e3).optional(),
	artifact: union([RepoPathSchema, record(BundleNameSchema, RepoPathSchema)]).optional(),
	program: BundleNameSchema.optional(),
	args: array(string().max(4e3)).max(100).default([]),
	env: record(string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), string().max(4e3)).default({}),
	isolated: boolean().default(false),
	reach: array(int().min(1).max(65535)).max(16).default([]),
	stopGraceSeconds: int().min(1).max(600).optional()
}).strict().refine((target) => target.command !== void 0 || target.artifact !== void 0, `a target needs a "command" (to run in the sandbox) or an "artifact" (to run on your computers), or both`).refine((target) => target.command === void 0 || SANDBOX_TARGET_NAME.test(target.name), `a target that runs in the sandbox names its preview address: lowercase letters, digits and dashes, starting with a letter`);
object({ targets: array(RunTargetSchema).min(1).max(50).refine((targets) => new Set(targets.map((target) => target.name)).size === targets.length, "two targets share a name") }).strict();
object({
	repos: array(object({
		repo: string(),
		path: string(),
		targets: array(RunTargetSchema),
		error: string().optional()
	})),
	devices: array(object({
		id: string(),
		online: boolean(),
		programs: boolean(),
		allowed: boolean()
	}))
});
var RunStartSchema = object({
	repo: string().min(1),
	target: ArtifactNameSchema,
	device: string().min(1).max(100)
});
object({ session: string() });
var DeviceRunStateSchema = _enum([
	"running",
	"ended",
	"unknown"
]);
var RunBuiltFromSchema = object({
	commit: string().min(1).max(64),
	changed: int().nonnegative(),
	at: string(),
	movedDuringBuild: boolean().optional()
});
var DeviceRunSchema = object({
	device: string(),
	id: string(),
	name: string(),
	state: DeviceRunStateSchema,
	said: string(),
	exitCode: int().optional(),
	startedAt: string(),
	endedAt: string().optional(),
	repo: string().optional(),
	ports: array(int().min(1).max(65535)),
	startedBy: string().optional(),
	builtFrom: RunBuiltFromSchema.optional(),
	landsSince: int().nonnegative().optional()
});
object({ device: string().min(1).max(100) });
var RunTerminalSchema = object({
	repo: string(),
	target: string(),
	session: string()
});
object({
	runs: array(DeviceRunSchema),
	terminals: array(RunTerminalSchema),
	error: string().optional()
});
RunStartSchema.extend({ id: string().min(1).max(200) });
RunStartSchema.extend({ id: string().min(1).max(200).optional() });
object({ stopped: array(object({
	id: string(),
	text: string()
})) });
object({
	device: string().min(1).max(100),
	id: string().min(1).max(200),
	since: number().int().nonnegative().optional(),
	lines: number().int().positive().max(2e3).default(200)
});
object({
	run: DeviceRunSchema.optional(),
	total: int().nonnegative(),
	lines: array(string())
});
var WORKSPACE_STATE_FILES = [
	{
		path: ".intentic/config/capabilities.json",
		invalidates: [
			"capabilities",
			"extensions",
			"environment",
			"panels",
			"manifests"
		],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/capability-dismissals.json",
		invalidates: ["capabilities"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/records/secret-uses.json",
		invalidates: ["secrets"],
		portability: "carry"
	},
	{
		path: ".intentic/records/wallet-ledger.json",
		invalidates: [],
		why: "Rendered through the wallet CLI and the capability card's live status probe, not from a browser query key.",
		portability: "carry"
	},
	{
		path: ".intentic/config/roles.json",
		invalidates: [
			"roles",
			"capabilities",
			"manifests"
		],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/areas.json",
		invalidates: ["areas", "manifests"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/environment.custom.Dockerfile",
		invalidates: ["environment"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/environment.Dockerfile",
		invalidates: ["environment"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/environment.d/",
		invalidates: ["environment"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/local/environment.approved.Dockerfile",
		invalidates: ["environment"],
		portability: "derived",
		note: "The target composes its own overlay on first boot; rebuild it there to install the tools it names."
	},
	{
		path: ".intentic/config/settings.json",
		invalidates: ["settings", "manifests"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/safety.md",
		invalidates: ["safety-policy"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/home.md",
		invalidates: [],
		portability: "carry",
		versioned: true,
		why: "Read per home turn; no view shows it."
	},
	{
		path: ".intentic/local/safety-log.json",
		invalidates: ["safety-log"],
		portability: "derived",
		note: "The target starts its own record of what it decided."
	},
	{
		path: ".intentic/local/privacy-log.json",
		invalidates: ["privacy-log"],
		portability: "derived",
		note: "The target starts its own record of what its shield did."
	},
	{
		path: ".intentic/config/autostart.json",
		invalidates: [],
		why: "The browser reads what is running off /panels; this file only tells the daemon what to start at boot.",
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/heavy-commands.json",
		invalidates: ["settings"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/local/rule-firings.json",
		invalidates: ["rule-firings"],
		portability: "derived",
		note: "Stamps of when each rule last did something; the new sandbox starts its own record."
	},
	{
		path: ".intentic/records/runtime-installs.json",
		invalidates: ["environment"],
		portability: "carry"
	},
	{
		path: ".intentic/records/needs.json",
		invalidates: ["needs"],
		portability: "carry"
	},
	{
		path: ".intentic/config/engines.json",
		invalidates: ["engines"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/approvals/",
		invalidates: ["approvals"],
		portability: "carry",
		versioned: true,
		authored: true
	},
	{
		path: ".intentic/config/automations.json",
		invalidates: [],
		why: "Declared by the intentic.automations extension's contributes.files, `automations` is its query key, not core's.",
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/records/automation-runs.json",
		invalidates: [],
		why: "Declared by the intentic.automations extension's contributes.files, `automations` is its query key, not core's.",
		portability: "carry"
	},
	{
		path: ".intentic/records/automation-schedule.json",
		invalidates: [],
		why: "Scheduler bookkeeping nothing in the browser renders: what a catch-up fire produces reaches the run ledger, which carries the automations key.",
		portability: "carry"
	},
	{
		path: ".intentic/records/automation-watch.json",
		invalidates: [],
		why: "Declared by the intentic.automations extension's contributes.files, `automations` is its query key, not core's.",
		portability: "carry"
	},
	{
		path: ".intentic/records/automation-state/",
		invalidates: [],
		why: "A guard's own scratch file; the daemon never reads it and nothing in the browser renders it.",
		portability: "carry"
	},
	{
		path: ".intentic/records/approvals/",
		invalidates: [],
		why: "Where releases before 2026-10-12 kept the wakes automations held for a person; they now sit on the history volume, and nothing reads this copy. The intentic.approvals extension's contributes.files still binds it, with `automation-approvals` as its query key, not core's.",
		portability: "carry"
	},
	{
		path: ".intentic/records/issues/",
		invalidates: [],
		why: "Declared by the intentic.issues extension's contributes.files, `issues` is its query key, not core's.",
		portability: "carry"
	},
	{
		path: ".intentic/records/outbox/",
		invalidates: [],
		why: "No view shows it yet; the `projects outbox` command reads it through the daemon.",
		portability: "carry"
	},
	{
		path: ".intentic/records/chores/",
		invalidates: [],
		why: "Declared by the intentic.maintenance extension's contributes.files, `maintenance-report`/`maintenance-runs` are its query keys, not core's.",
		portability: "carry"
	},
	{
		path: ".intentic/config/docs/",
		invalidates: [],
		why: "Declared by the intentic.documentation extension's contributes.files, `documentation`/`documentation-runs` are its query keys, not core's.",
		portability: "carry",
		authored: true,
		outsideWriter: "the intentic.documentation extension's staging writes (its paths.ts)"
	},
	{
		path: ".intentic/config/workflows.json",
		invalidates: ["workflows"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/records/workflow-runs.json",
		invalidates: ["workflows", "workflow-runs"],
		portability: "carry"
	},
	{
		path: ".intentic/config/loop-designs.json",
		invalidates: ["loop-designs"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/records/loops.json",
		invalidates: [],
		why: "Ralph loops and their iteration history. Nothing observes it: where a RUNNING loop stands rides on the fleet roster (AgentSummary.loop), which the /events stream already pushes about once a second, and a second source invalidating on this file could only ever disagree with the card beside it. The iteration list of an ENDED loop is an on-demand read, nothing renders it until someone opens it (web's useLoops, which holds no query for exactly this reason).",
		portability: "carry"
	},
	{
		path: ".intentic/records/webchat-installs.json",
		invalidates: [],
		why: "Which origins have loaded a Visitor chat's widget, written on a 30s flush timer while a customer's site serves page views. The install panel that renders it fetches on open and polls itself while it is on screen, which is the whole window in which the answer changes for anyone. Pushing instead would bill every connected browser a refetch per flush, for a panel almost nobody has open.",
		portability: "carry"
	},
	{
		path: ".intentic/records/issue-installs.json",
		invalidates: [],
		why: "The same probe for the bug reporter's script, on the same flush timer and read by the same kind of panel, so it is outside the push path for the same reason the Visitor chat's is.",
		portability: "carry"
	},
	{
		path: ".intentic/records/webchat-outbox.json",
		invalidates: [],
		why: "Visitor chat replies a visitor has not collected yet, written when an approved wake answers or a human writes as the agent. The only reader is a stranger's browser polling the public /webchat door, which no query key in this app addresses; the owner's own view of the same words is the conversation's transcript, which the agent registry already pushes.",
		portability: "carry"
	},
	{
		path: ".intentic/records/thread-sessions.json",
		invalidates: [],
		why: "Thread bookkeeping (an inbound thread, a Visitor chat visitor, a Discord or Slack channel, → sandbox conversation + provider session), written on EVERY inbound message. Nothing in the browser reads it: what a thread produces is a conversation, and the fleet board already learns about that from the agent registry's own push. Naming a key here would bill every connected browser a refetch per inbound message, the request storm this table's own note warns about, to refresh nothing it can see.",
		portability: "carry"
	},
	{
		path: ".intentic/records/senders.json",
		invalidates: [],
		why: "Who has written to each listener source, written on every inbound message that reached an automation. Read only while the automation editor's sender picker is open, which fetches it on open; a live key here would refetch every connected browser per Discord message to refresh a list nobody has on screen.",
		portability: "carry"
	},
	{
		path: ".intentic/config/extension-settings.json",
		invalidates: [],
		why: "Held in a module-level shallowRef store per extension (web's extensionSettingsStore) with no query observer, and deliberately so: api.settings.get must answer SYNCHRONOUSLY from an extension's first activate() line, and the store outlives every component scope. A module-level QueryObserver is the one shape that would make invalidation refetch, and this app already ruled it out, it detaches on the queryClient.clear() at logout (see useSandbox's sandbox-list mirror). So a remote member's setting edit reaches this browser on its next load, not live.",
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/extension-enablement.json",
		invalidates: ["extensions"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/workspace-extensions/",
		invalidates: ["extensions"],
		portability: "carry",
		versioned: true,
		authored: true
	},
	{
		path: ".intentic/records/extension-updates.json",
		invalidates: ["extensions"],
		portability: "carry"
	},
	{
		path: ".intentic/records/conversions.json",
		invalidates: [],
		why: "Written once per update that converted something, at boot before any browser is connected; the update card reads the plan from the new image instead.",
		portability: "carry"
	},
	{
		path: ".intentic/config/extension-update-policy.json",
		invalidates: ["extensions"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/local/extension-dev.json",
		invalidates: ["extensions"],
		portability: "derived",
		note: "Extensions run their pinned versions on the target; point one at its source checkout again there if you were working on it."
	},
	{
		path: ".intentic/records/extension-usage.json",
		invalidates: [],
		why: "Which of the routes each extension DECLARED it has actually called, the evidence behind the permissions list on its row. The one entry here whose empty set is a RATE decision rather than an architectural one: every browser with the app open reports its batch on a timer, so wiring this to the `extensions` query would refetch the whole list every few seconds for a figure nobody is watching change. The tab reads it when it loads, which is when anyone is reading it.",
		portability: "carry"
	},
	{
		path: ".intentic/identity/members.json",
		invalidates: [],
		why: "Where releases before 2026-10-06 kept the daemon's enforced roster; it now lives on the history volume (`identity/members.json`), off the workspace every turn writes, and nothing reads this copy. Kept declared, locked and never exported, since it may still hold a pre-move roster a rollback reads.",
		portability: "identity",
		note: "Re-invite collaborators from the Access tab, a grant is the platform's record, and the target enforces its own copy."
	},
	{
		path: ".intentic/secrets/auth/",
		invalidates: [],
		why: "AI-provider credentials and runtime homes, plus the capability and extension-settings secret vaults; each account is rendered through owner-gated provider routes.",
		portability: "secret",
		note: "Sign the agent's AI accounts in again on the Agent tab, then re-enter each connection's credential on Capabilities and each extension's secret settings on Extensions, both arrived listed but unauthenticated."
	},
	{
		path: ".intentic/records/sessions/claude/",
		invalidates: [],
		why: "Agent session transcripts; nothing derives from watching them, and descending into them would cost a fifth of the watcher.",
		portability: "carry"
	},
	{
		path: ".intentic/records/artifacts/",
		invalidates: [],
		why: "Durable outputs owned by conversations and extension runs: attachments, browser captures, generated images, acceptance reports, workflow step reports, voice transcripts, and loop ledgers.",
		portability: "carry",
		backup: false
	},
	{
		path: ".intentic/records/artifacts/attachments/",
		invalidates: [],
		why: "Files people attached to their messages: uploaded before the message is sent, read back by the turn it starts.",
		portability: "carry"
	},
	{
		path: ".intentic/local/cache/",
		invalidates: [],
		why: "Rebuildable indexes and caches, the speech models an image does not bake, fileq's derived/ markdown shadows of binary files; ignored by the watcher and recreated from carried workspace content.",
		portability: "derived"
	},
	{
		path: ".intentic/local/runtime/",
		invalidates: [],
		why: "Extension runtime scratch (watermarks, cached short-lived tokens); nothing renders it and gateways re-derive it.",
		portability: "derived",
		outsideWriter: "extensions, through extensionStateDir below"
	},
	{
		path: ".intentic/local/tmp/",
		invalidates: [],
		why: "Scratch that agents and tools leave behind (build logs, demo checkouts); nothing reads it after the turn that wrote it. The state janitor empties it at boot.",
		portability: "derived"
	},
	{
		path: ".intentic/local/trash/",
		invalidates: [],
		why: "Entries deleted from the file view, held for a day so Undo can restore them; nothing renders it, and the janitor expires it.",
		portability: "derived"
	},
	{
		path: ".intentic/local/.pnpm-store/",
		invalidates: [],
		why: "pnpm's content-addressable store, auto-created by installs run from under .intentic; the next install rebuilds it.",
		portability: "derived",
		outsideWriter: "pnpm itself, when an install runs from under .intentic"
	},
	{
		path: ".intentic/local/newest-run.json",
		invalidates: [],
		why: "The newest daemon version that ever ran this workspace (store/newest-run.ts), a downgrade tripwire, about THIS sandbox the way rule-firings is.",
		portability: "derived",
		note: "The target stamps its own daemon version on first boot."
	},
	{
		path: ".intentic/secrets/converting/",
		invalidates: [],
		why: "Pre-images of the files an update's conversions changed; only the boot step reads them, to put a rolled-back version's files back.",
		portability: "secret",
		note: "An export does not carry an update's undo record; the target converts its own files."
	},
	{
		path: ".intentic/secrets/ci.json",
		invalidates: [],
		why: "Webhook secret + conclusion memory; the Pipelines view reads it through /ci/runs, not off disk.",
		portability: "secret",
		note: "Re-add the CI webhook on the Pipelines view, its secret is per-sandbox."
	},
	{
		path: ".intentic/secrets/doors.json",
		invalidates: [],
		why: "The credentials behind the event webhooks, release gates and bug intakes; each surface reads its own through /automations and /workflows, never off disk.",
		portability: "secret",
		note: "Webhook, gate and intake URLs are minted fresh on the first read here: re-copy each into its caller's secret store."
	},
	{
		path: ".intentic/identity/control-tokens.json",
		invalidates: [],
		why: "Where releases before 2026-10-06 kept the hashed control tokens; they now live on the history volume (`identity/control-tokens.json`), and nothing reads this copy.",
		portability: "identity",
		backup: false,
		note: "Mint fresh control tokens, the old ones authenticate against the source sandbox."
	},
	{
		path: ".intentic/identity/owner.json",
		invalidates: [],
		why: "Where releases before 2026-10-06 kept the bound owner; it now lives on the history volume (`identity/owner.json`), and nothing reads this copy.",
		portability: "identity"
	},
	{
		path: ".intentic/identity/workspace.json",
		invalidates: [],
		why: "The workspace identity, read from the /events hello frame rather than as a file.",
		portability: "identity"
	},
	{
		path: ".intentic/identity/passkeys.json",
		invalidates: [],
		why: "Where earlier releases kept the passkeys registered with this sandbox, whether one is required to open it, and the hashes of the owner's recovery codes; they now live on the history volume (`identity/passkeys.json`), off the workspace every turn writes, and nothing reads this copy.",
		portability: "identity",
		note: "Passkeys are bound to the sandbox they were registered with: add them again on the new one from its Access tab."
	},
	{
		path: ".intentic/config/templates.json",
		invalidates: [],
		why: "Scaffold templates, read when the scaffold dialog opens.",
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/local/browser/",
		invalidates: [],
		why: "Browser-login profiles: Chromium rewrites these constantly. Descent-ignored by the watcher outright.",
		portability: "derived",
		note: "Log the agent's browser back into any site it needs, profiles do not travel."
	},
	{
		path: ".intentic/local/extensions/",
		invalidates: [],
		why: "Extension checkouts, whole git clones. The `extensions` query is driven by the capability manifest above, not by their contents.",
		portability: "derived",
		note: "Extensions re-clone from the capability manifest on the target's next reconcile."
	},
	{
		path: ".intentic/records/plugins/",
		invalidates: [],
		why: "Agent plugin dirs, read by the SDK's loader each turn.",
		portability: "carry"
	},
	{
		path: ".intentic/config/skills/",
		invalidates: ["skills"],
		portability: "carry",
		versioned: true
	},
	{
		path: ".intentic/config/roles/",
		invalidates: ["roles"],
		portability: "carry",
		versioned: true
	}
];
[...WORKSPACE_STATE_FILES.filter((file) => file.versioned).map((file) => file.path), ...ROOT_PROJECT_PATHS];
WORKSPACE_STATE_FILES.filter((file) => file.versioned || file.authored).map((file) => file.path);
var STATE_GROUP_DIR = {
	config: `${STATE_DIR}/config`,
	records: `${STATE_DIR}/records`,
	local: `${STATE_DIR}/local`,
	identity: `${STATE_DIR}/identity`,
	secrets: `${STATE_DIR}/secrets`
};
var STATE_GROUPS = Object.keys(STATE_GROUP_DIR);
var stateGroupOf = (file) => {
	switch (file.portability) {
		case "secret": return "secrets";
		case "identity": return "identity";
		case "derived": return "local";
		case "carry": return file.versioned === true || file.authored === true ? "config" : "records";
	}
};
STATE_GROUPS.flatMap((group) => {
	const files = WORKSPACE_STATE_FILES.filter((file) => stateGroupOf(file) === group);
	return files.some((file) => file.versioned === true) ? files.filter((file) => file.versioned !== true).map((file) => file.path) : [`${STATE_GROUP_DIR[group]}/`];
});
var BACKED_UP_STATE_PATHS = WORKSPACE_STATE_FILES.filter((file) => file.backup !== false && (file.portability === "carry" || file.portability === "identity")).map((file) => file.path);
WORKSPACE_STATE_FILES.filter((file) => !BACKED_UP_STATE_PATHS.includes(file.path)).map((file) => file.path);
var segmentOf = (name) => name.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
var extensionCacheDir = (identity) => `${STATE_GROUP_DIR.local}/cache/extensions/${segmentOf(identity)}`;
WORKSPACE_STATE_FILES.filter((file) => file.invalidates.includes("manifests")).map((file) => file.path);
var TRANSIENT_RENAME = /* @__PURE__ */ new Set([
	"EPERM",
	"EACCES",
	"EBUSY"
]);
var RENAME_ATTEMPTS = 10;
var RENAME_RETRY_MS = 25;
var renameOver = async (from, to) => {
	for (let attempt = 1;; attempt++) try {
		await rename(from, to);
		return;
	} catch (error) {
		if (process.platform !== "win32" || attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME.has(error.code ?? "")) throw error;
		await setTimeout$1(RENAME_RETRY_MS);
	}
};
var stagingOf = (path) => join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
var writeStaged = async (staging, write, mode, durable) => {
	const handle = await open(staging, "w", mode);
	try {
		await write(handle);
		if (durable) await handle.sync();
	} finally {
		await handle.close();
	}
};
var directoriesToSync = (dirs, upTo) => {
	const top = upTo === void 0 ? void 0 : resolve(upTo);
	const seen = /* @__PURE__ */ new Set();
	for (const dir of dirs) for (let directory = resolve(dir); !seen.has(directory); directory = dirname(directory)) {
		seen.add(directory);
		const parent = dirname(directory);
		if (top === void 0 || directory === top || parent === directory || !isUnder(top, directory)) break;
	}
	return [...seen];
};
var isUnder = (top, path) => path === top || path.startsWith(top.endsWith("/") ? top : `${top}/`);
var syncDirectories = async (dirs, options = {}) => {
	if (process.platform === "win32") return;
	for (const directory of directoriesToSync(dirs, options.upTo)) await syncOne(directory);
};
var syncOne = async (directory) => {
	let handle;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch {} finally {
		await handle?.close().catch(() => void 0);
	}
};
var replaceAtomically = async (path, write, mode, options) => {
	const staging = stagingOf(path);
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeStaged(staging, write, mode, options.durable === true);
		if (options.owner !== void 0) await chown(staging, options.owner.uid, options.owner.gid);
		if (mode !== void 0) await chmod(staging, mode);
		await renameOver(staging, path);
	} finally {
		await rm(staging, { force: true });
	}
	if (options.durable === true) await syncDirectories([dirname(path)], options.syncUpTo === void 0 ? {} : { upTo: options.syncUpTo });
};
var writeFileAtomic = async (path, content, mode, options = {}) => await replaceAtomically(path, async (handle) => await handle.writeFile(content), mode, options);
// src/cache.ts
var EnvelopeSchema = object({
	savedAt: string(),
	value: unknown()
});
var fileOf = (root, key) => {
	const [group = "", ...rest] = key.split("/");
	return join(root, group, `${rest.join("-").replaceAll(/[^\w.-]/gu, "_")}.json`);
};
var Cache = class {
	root;
	now;
	constructor(root, now) {
		this.root = root;
		this.now = now;
	}
	async read(key, schema) {
		const raw = await readFile(fileOf(this.root, key), "utf8").catch(undefinedIfMissing);
		if (raw === void 0) return;
		const envelope = EnvelopeSchema.parse(JSON.parse(raw));
		const value = schema.safeParse(envelope.value);
		return value.success ? {
			value: value.data,
			savedAt: envelope.savedAt
		} : void 0;
	}
	async write(key, value) {
		const savedAt = this.now().toISOString();
		await writeFileAtomic(fileOf(this.root, key), JSON.stringify({
			savedAt,
			value
		}));
		return {
			value,
			savedAt
		};
	}
	async through(key, schema, load, freshness = {}) {
		const cached = await this.read(key, schema);
		const age = cached === void 0 ? Number.POSITIVE_INFINITY : this.now().getTime() - Date.parse(cached.savedAt);
		if (cached !== void 0 && freshness.refresh !== true && (freshness.maxAgeMs === void 0 || age < freshness.maxAgeMs)) return cached;
		try {
			return await this.write(key, await load());
		} catch (error) {
			if (cached === void 0) throw error;
			return {
				...cached,
				stale: errorMessage(error)
			};
		}
	}
};
// src/args.ts
var UsageError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
};
var SWITCHES = /* @__PURE__ */ new Set([
	"json",
	"refresh",
	"original",
	"unified",
	"in-force",
	"repealed",
	"full",
	"all",
	"help"
]);
var VALUED = /* @__PURE__ */ new Set([
	"keyword",
	"type",
	"year",
	"publisher",
	"limit",
	"from",
	"to",
	"act",
	"regulation",
	"legal-base",
	"case",
	"court"
]);
var parseArgs = (argv) => {
	const positional = [];
	const flags = /* @__PURE__ */ new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const [name = "", inline] = token.slice(2).split(/=(.*)/su);
		if (SWITCHES.has(name)) {
			flags.set(name, true);
			continue;
		}
		if (!VALUED.has(name)) throw new UsageError(`unknown flag --${name} (prawo --help lists them)`);
		const value = inline ?? argv[index + 1];
		if (value === void 0 || inline === void 0 && value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
		flags.set(name, value);
		index += inline === void 0 ? 1 : 0;
	}
	return {
		positional,
		flags
	};
};
var flag = (args, name) => {
	const value = args.flags.get(name);
	return value === true ? void 0 : value;
};
var has = (args, name) => args.flags.has(name);
var limitOf = (args, fallback) => {
	const raw = flag(args, "limit");
	const value = raw === void 0 ? fallback : Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 100) throw new UsageError(`--limit must be a whole number from 1 to 100, got "${raw ?? String(fallback)}"`);
	return value;
};
var dateOf = (args, name) => {
	const value = flag(args, name);
	if (value !== void 0 && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new UsageError(`--${name} takes a date as YYYY-MM-DD, got "${value}"`);
	return value;
};
// src/law/citation.ts
var MONTHS = [
	"stycznia",
	"lutego",
	"marca",
	"kwietnia",
	"maja",
	"czerwca",
	"lipca",
	"sierpnia",
	"września",
	"października",
	"listopada",
	"grudnia"
];
var polishDate = (iso) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(iso);
	if (match === null) return iso;
	return `${String(Number(match[3]))} ${MONTHS[Number(match[2]) - 1] ?? ""} ${match[1] ?? ""} r.`;
};
var JOURNALS = /* @__PURE__ */ new Map([["DU", "Dz. U."], ["MP", "M. P."]]);
var journalAddress = (act) => {
	const journal = JOURNALS.get(act.publisher) ?? act.publisher;
	const issue = act.volume !== void 0 && act.volume > 0 ? `Nr ${String(act.volume)}, ` : "";
	return `${journal} z ${String(act.year)} r. ${issue}poz. ${String(act.pos)}`;
};
var eliUri = (act) => `https://eli.gov.pl/eli/${act.ELI}/ogl`;
var isapUrl = (act) => act.address === void 0 ? void 0 : `https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=${act.address}`;
var GENITIVE = /* @__PURE__ */ new Map([
	["Ustawa", "ustawy"],
	["Rozporządzenie", "rozporządzenia"],
	["Obwieszczenie", "obwieszczenia"],
	["Uchwała", "uchwały"],
	["Zarządzenie", "zarządzenia"],
	["Dekret", "dekretu"],
	["Konstytucja", "Konstytucji"],
	["Umowa", "umowy"],
	["Regulamin", "regulaminu"]
]);
var actName = (act, inGenitive = true) => {
	const [first = "", ...rest] = act.title.replace(/\.$/u, "").replaceAll(/\s+-\s+/gu, " – ").split(" ");
	return [inGenitive ? GENITIVE.get(first) ?? first : first, ...rest].join(" ").replace(/(\d{4} r\.) (?=\p{Lu})/u, "$1 – ");
};
var inSentence = (marker) => marker.replace(/^Art\./u, "art.");
var actCitation = ({ act, basis, laterAmendments }, marker) => {
	const where = `${journalAddress(basis)}${laterAmendments ? ", z późn. zm." : ""}`;
	if (marker === void 0) return `${actName(act, false)} (${where})`;
	const annex = /^Załącznik nr (\S+) (.*)$/u.exec(marker);
	return `${annex === null ? inSentence(marker) : `${annex[2] ?? ""} załącznika nr ${annex[1] ?? ""} do`} ${actName(act)} (${where})`;
};
var RULING_FORMS = /* @__PURE__ */ new Map([
	["SENTENCE", "wyrok"],
	["DECISION", "postanowienie"],
	["RESOLUTION", "uchwała"],
	["REASONS", "uzasadnienie"],
	["REGULATION", "zarządzenie"]
]);
var COURTS$1 = /* @__PURE__ */ new Map([
	["SUPREME", "Sąd Najwyższy"],
	["CONSTITUTIONAL_TRIBUNAL", "Trybunał Konstytucyjny"],
	["NATIONAL_APPEAL_CHAMBER", "Krajowa Izba Odwoławcza"],
	["ADMINISTRATIVE", "Sąd administracyjny"]
]);
var courtName = (hit) => {
	const court = hit.division?.court?.name ?? COURTS$1.get(hit.courtType) ?? hit.courtType;
	const chamber = hit.division?.chambers?.[0]?.name;
	return chamber === void 0 ? court : `${court}, ${chamber}`;
};
var saosUrl = (id) => `https://www.saos.org.pl/judgments/${String(id)}`;
var rulingCitation = (hit) => {
	const form = RULING_FORMS.get(hit.judgmentType ?? "") ?? "orzeczenie";
	const date = hit.judgmentDate === void 0 || hit.judgmentDate === null ? "" : ` z dnia ${polishDate(hit.judgmentDate)}`;
	const cases = (hit.courtCases ?? []).map((entry) => entry.caseNumber).join(", ");
	return `${courtName(hit)}, ${form}${date}${cases === "" ? "" : `, sygn. akt ${cases}`}; SAOS: ${saosUrl(hit.id)}`;
};
// src/text/model.ts
var SUPERSCRIPT = new Map(Object.entries({
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ"
}));
var PLAIN = new Map([...SUPERSCRIPT].map(([plain, raised]) => [raised, plain]));
var RAISED = new RegExp(`[${[...PLAIN.keys()].join("")}]+`, "gu");
var superscript = (value) => [...value].map((char) => SUPERSCRIPT.get(char) ?? char).join("");
var articleKey = (raw) => raw.trim().replace(/^(?:art\.?|§)\s*/iu, "").replace(RAISED, (raised) => `^${[...raised].map((char) => PLAIN.get(char) ?? char).join("")}`).replace(/\[(\w+)\]|\((\d\w*)\)|_(\w+)/gu, (_, bracket, paren, under) => `^${bracket ?? paren ?? under ?? ""}`).replace(/\s*[–-]\s*/gu, "-").replace(/\.$/u, "").replaceAll(/\s+/gu, "").toLowerCase();
var displayNumber = (key) => key.split("-").map((part) => part.replace(/\^(\w+)/u, (_, raised) => superscript(raised))).join("–");
var articleMarker = (top, key) => `${top === "art" ? "Art." : "§"} ${displayNumber(key)}`;
var ordinal = (value) => {
	const match = /^(\d+)(.*)$/u.exec(value);
	return match === null ? [NaN, value] : [Number(match[1]), match[2] ?? ""];
};
var follows = (next, previous) => {
	if (previous === void 0) return true;
	const [nextBase, nextRest] = ordinal(next);
	const [previousBase, previousRest] = ordinal(previous);
	return nextBase > previousBase || nextBase === previousBase && nextRest > previousRest;
};
var LEVELS = [
	"par",
	"ust",
	"pkt",
	"lit",
	"tiret"
];
var ArticleBuilder = class {
	number;
	marker;
	heading;
	units = [];
	notes = [];
	path = /* @__PURE__ */ new Map();
	tirets = 0;
	constructor(number, marker, heading) {
		this.number = number;
		this.marker = marker;
		this.heading = heading;
	}
	current(level) {
		return this.path.get(level);
	}
	open(level, value, label) {
		for (const deeper of LEVELS.slice(LEVELS.indexOf(level))) this.path.delete(deeper);
		if (level === "tiret") this.tirets += 1;
		else {
			this.tirets = 0;
			this.path.set(level, value);
		}
		const unit = {
			marker: this.markerAt(level),
			label,
			text: ""
		};
		this.units.push(unit);
		return unit;
	}
	write(unit, text) {
		const marker = unit?.marker ?? this.marker;
		const last = this.units.at(-1);
		if (last !== void 0 && (last === unit || unit === void 0 && last.marker === marker)) {
			last.text = joinLine(last.text, text);
			return;
		}
		this.units.push({
			marker,
			label: "",
			text
		});
	}
	continue(text) {
		this.write(this.units.at(-1), text);
	}
	note(text, whole = false) {
		const marker = whole ? this.marker : this.units.at(-1)?.marker ?? this.marker;
		if (!this.notes.some((note) => note.marker === marker && note.text === text)) this.notes.push({
			marker,
			text
		});
	}
	build() {
		return {
			number: this.number,
			marker: this.marker,
			heading: this.heading,
			units: this.units,
			notes: this.notes
		};
	}
	markerAt(level) {
		const parts = [this.marker];
		const par = this.path.get("par");
		const ust = this.path.get("ust");
		const pkt = this.path.get("pkt");
		const lit = this.path.get("lit");
		if (par !== void 0) parts.push(`§ ${par}`);
		if (ust !== void 0 && level !== "par") parts.push(`ust. ${ust}`);
		if (pkt !== void 0 && (level === "pkt" || level === "lit" || level === "tiret")) parts.push(`pkt ${pkt}`);
		if (lit !== void 0 && (level === "lit" || level === "tiret")) parts.push(`lit. ${lit}`);
		if (level === "tiret") parts.push(`tiret ${String(this.tirets)}`);
		return parts.join(" ");
	}
};
var joinLine = (before, after) => {
	if (before === "") return after;
	if (/\p{L}-$/u.test(before) && /^\p{Ll}/u.test(after)) return `${before.slice(0, -1)}${after}`;
	return `${before} ${after}`;
};
var unitToken = (token) => token.replace(/^(?:par\.?|§)$/iu, "§").replace(/^ust\.?$/iu, "ust.").replace(/^pkt\.?$/iu, "pkt").replace(/^lit\.?$/iu, "lit.");
var parseAddress = (raw) => {
	const annex = /^zał(?:ącznik)?\.?\s*(?:nr\s*)?(\d+[a-z]?)\s*,?\s*/iu.exec(raw.trim());
	if (annex !== null) {
		const inner = parseAddress(raw.trim().slice(annex[0].length));
		return {
			article: `z${(annex[1] ?? "").toLowerCase()}:${inner.article}`,
			rest: inner.rest
		};
	}
	const [first = "", ...tail] = raw.trim().replace(/^(?:art\.?|§)\s*/iu, "").replace(/§\s*/gu, "§ ").replace(/\b(ust|pkt|lit|par)\.?\s*/giu, "$1 ").split(/\s+/u);
	const rest = [];
	for (let index = 0; index < tail.length; index += 2) {
		const kind = unitToken(tail[index] ?? "");
		const value = (tail[index + 1] ?? "").replace(/[.)]$/u, "").toLowerCase();
		if (![
			"§",
			"ust.",
			"pkt",
			"lit."
		].includes(kind) || value === "") throw new Error(`cannot read "${raw}" as an article address: write it like "35 § 1", "31 ust. 2 pkt 3" or "22[1]"`);
		rest.push(`${kind} ${value}`);
	}
	return {
		article: articleKey(first),
		rest: rest.join(" ")
	};
};
var findArticle = (text, key) => text.articles.find((article) => article.number === key);
var within = (marker, outer) => marker === outer || marker.startsWith(`${outer} `);
var notesFor = (article, rest) => {
	if (rest === "") return article.notes;
	const selected = `${article.marker} ${rest}`;
	return article.notes.filter((note) => note.marker === article.marker || within(note.marker, selected) || within(selected, note.marker));
};
var selectUnits = (article, rest) => {
	if (rest === "") return article.units;
	const marker = `${article.marker} ${rest}`;
	return article.units.filter((unit) => within(unit.marker, marker));
};
// src/text/html.ts
var ENTITIES = /* @__PURE__ */ new Map([
	["nbsp", " "],
	["amp", "&"],
	["lt", "<"],
	["gt", ">"],
	["quot", "\""],
	["apos", "'"]
]);
var decode = (value) => value.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (whole, entity) => {
	if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
	if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
	return ENTITIES.get(entity.toLowerCase()) ?? whole;
});
var clean = (value) => decode(value.replaceAll(/<\/?(?:p|div|br|h\d|li|ul|ol|table|tr|td)\b[^>]*>/giu, " ").replaceAll(/<[^>]*>/gu, "")).replaceAll(/\s+/gu, " ").replaceAll(/\(\s+/gu, "(").replaceAll(/\s+([),.;:])/gu, "$1").trim();
var htmlLines = (html) => html.split(/<\/(?:p|div|h\d|li|tr)>|<br\s*\/?>/iu).map(clean).filter((line) => line !== "");
var headingText = (value) => value.split(/<\/p>/iu).map(clean).filter((line) => line !== "").join(" — ");
var FOOTNOTE = /<a\b[^>]*gloss-link[^>]*>\s*<sup>\s*(\d+)\)\s*<\/sup>\s*<span[^>]*tooltip-text[^>]*>([\s\S]*?)<\/span>\s*<\/span>\s*<\/a>/giu;
var PLACEHOLDER = /\u0001(\d+)\u0001/gu;
var liftFootnotes = (html, footnotes) => html.replaceAll(FOOTNOTE, (_, ref, note) => {
	footnotes.set(Number(ref), clean(note));
	return `\u0001${ref}\u0001`;
});
var textPart = (html) => {
	const sections = [...html.matchAll(/<section\b[^>]*id="part_\d+"[^>]*>([\s\S]*?)<\/section>/giu)].map((match) => match[1] ?? "");
	const annex = sections.findIndex((section) => /<h2\b[^>]*>[\s\S]*?Tekst jednolity[\s\S]*?<\/h2>/iu.test(section));
	if (annex >= 0) {
		const notice = sections.slice(0, annex).map(clean).join(" ").replace(/^Treść obwieszczenia\s*/u, "");
		return {
			body: sections[annex] ?? "",
			notice: notice === "" ? void 0 : notice
		};
	}
	return { body: sections[0] ?? html };
};
var LEVEL_OF = /* @__PURE__ */ new Map([
	["para", "par"],
	["pass", "ust"],
	["pint", "pkt"],
	["lett", "lit"],
	["tire", "tiret"]
]);
var HEADINGS = /* @__PURE__ */ new Set([
	"book",
	"part",
	"titl",
	"bran",
	"chpt",
	"schp"
]);
var Reader = class {
	footnotes;
	articles = [];
	stack = [];
	builder;
	top = "art";
	constructor(footnotes) {
		this.footnotes = footnotes;
	}
	read(body) {
		this.top = /class="unit unit_arti\b/u.test(body) ? "art" : "par";
		let at = 0;
		for (const tag of body.matchAll(/<(\/?)(div|h3)\b([^>]*)>/giu)) {
			this.text(body.slice(at, tag.index));
			at = tag.index + tag[0].length;
			if (tag[1] === "/") this.close(tag[2]?.toLowerCase() === "h3" ? "h3" : "div");
			else this.open(tag[2]?.toLowerCase() === "h3" ? "h3" : "div", tag[3] ?? "");
		}
		this.finish();
	}
	open(tag, attributes) {
		const kind = /class="unit unit_(\w+)/u.exec(attributes)?.[1];
		const collects = tag === "h3" || /data-template="xText"/iu.test(attributes);
		this.stack.push({
			tag,
			kind,
			collects,
			text: ""
		});
	}
	text(chunk) {
		const collector = this.stack.findLast((frame) => frame.collects);
		if (collector !== void 0 && chunk !== "") collector.text += chunk;
	}
	close(tag) {
		const index = this.stack.findLastIndex((frame) => frame.tag === tag);
		if (index < 0) return;
		const [frame] = this.stack.splice(index);
		if (frame === void 0 || !frame.collects) return;
		const owner = this.stack.findLast((candidate) => candidate.kind !== void 0);
		if (frame.tag === "h3") this.label(owner, frame.text);
		else this.wording(owner, frame.text);
	}
	label(owner, raw) {
		if (owner?.kind === void 0) return;
		const paragraphs = this.stack.filter((frame) => frame.kind === "para").length;
		if (owner.kind === "arti" && this.top === "art" || owner.kind === "para" && this.top === "par" && paragraphs === 1) {
			this.startArticle(raw);
			return;
		}
		if (HEADINGS.has(owner.kind)) {
			owner.heading = headingText(raw.replaceAll(PLACEHOLDER, ""));
			return;
		}
		const level = LEVEL_OF.get(owner.kind);
		if (level !== void 0 && this.builder !== void 0) {
			const label = clean(raw.replaceAll(PLACEHOLDER, ""));
			const value = level === "tiret" ? "" : label.replace(/^§\s*/u, "").replace(/[.)]$/u, "");
			owner.unit = this.builder.open(level, value, label);
			this.noteMarkers(raw);
		}
	}
	wording(owner, raw) {
		const text = clean(raw.replaceAll(PLACEHOLDER, ""));
		if (text !== "" && this.builder !== void 0) {
			this.builder.write(owner?.unit, text);
			this.noteMarkers(raw);
		}
	}
	startArticle(raw) {
		this.finish();
		const key = articleKey(clean(raw.replaceAll(PLACEHOLDER, "")).replace(/\.$/u, ""));
		const heading = this.stack.flatMap((frame) => frame.heading === void 0 ? [] : [frame.heading]).join(" / ");
		this.builder = new ArticleBuilder(key, articleMarker(this.top, key), heading === "" ? void 0 : heading);
		this.noteMarkers(raw, true);
	}
	noteMarkers(text, whole = false) {
		for (const match of text.matchAll(PLACEHOLDER)) {
			const ref = match[1] ?? "";
			const note = this.footnotes.get(Number(ref));
			if (note !== void 0 && !CITED_ACT_CHANGES$1.test(note)) this.builder?.note(`${ref}) ${note}`, whole);
		}
	}
	finish() {
		if (this.builder !== void 0) this.articles.push(this.builder.build());
		this.builder = void 0;
	}
};
var CITED_ACT_CHANGES$1 = /^Zmian[ay]\b.*\bwymienion/u;
var raise = (html) => html.replaceAll(/<sup>\s*([0-9a-z]{1,4})\s*<\/sup>/giu, (_, raised) => superscript(raised.toLowerCase()));
var articlesFromHtml = (html) => {
	const footnotes = /* @__PURE__ */ new Map();
	const { body, notice } = textPart(raise(liftFootnotes(html, footnotes)));
	const reader = new Reader(footnotes);
	reader.read(body);
	return {
		articles: reader.articles,
		notice: notice === void 0 ? void 0 : clean(notice.replaceAll(PLACEHOLDER, ""))
	};
};
// src/render.ts
var IN_FORCE = /* @__PURE__ */ new Map([
	["IN_FORCE", "obowiązuje"],
	["NOT_IN_FORCE", "nie obowiązuje"],
	["UNKNOWN", "status nieustalony"]
]);
var KINDS = /* @__PURE__ */ new Map([
	["act", "akt"],
	["amendment", "nowelizacja"],
	["consolidated", "tekst jednolity"]
]);
var inForceLabel = (act) => IN_FORCE.get(act.inForce ?? "UNKNOWN") ?? act.inForce ?? "status nieustalony";
var staleLine = (stale, savedAt) => stale === void 0 ? [] : [`(Z pamięci podręcznej${savedAt === void 0 ? "" : ` z ${savedAt.slice(0, 10)}`}: źródło niedostępne — ${stale})`];
var searchJson = (result) => ({
	total: result.total,
	stemmed: result.stemmed,
	items: result.items.map((hit) => ({
		...hit.act,
		kind: hit.kind,
		eli: eliUri(hit.act),
		citation: journalAddress(hit.act)
	}))
});
var searchMarkdown = (result) => {
	if (result.items.length === 0) return "Brak wyników. Tytuły odmieniają przedmiot („o dowodach osobistych”, „w sprawie instrukcji kancelaryjnej”): spróbuj takiej formy, krótszego fragmentu albo --keyword.";
	const lines = result.items.flatMap((hit) => [`- ${hit.act.ELI} · ${hit.act.title}`, `  ${[
		KINDS.get(hit.kind) ?? hit.kind,
		inForceLabel(hit.act),
		hit.act.status,
		journalAddress(hit.act),
		eliUri(hit.act)
	].filter(Boolean).join(" · ")}`]);
	return [
		...result.stemmed === void 0 ? [] : [`Dokładne słowa nic nie dały; szukano rdzeni: „${result.stemmed}”.`],
		`${String(result.total)} wyników · pokazano ${String(result.items.length)}: najpierw akty podstawowe, obowiązujące, najnowsze`,
		...lines,
		...staleLine(result.stale),
		"Dalej: prawo show <ID> — czy obowiązuje, tekst jednolity, zmiany po nim."
	].join("\n");
};
var laterInForce = (status) => status.amendmentsAfter.some((amendment) => !amendment.pending);
var basisOf = (text) => text.source === "unified" ? text.status.consolidated ?? text.status.act : text.edition;
var citationParts = (status, basis) => ({
	act: status.act,
	basis,
	laterAmendments: laterInForce(status)
});
var consolidatedLine = (status) => {
	const text = status.consolidated;
	if (text === void 0 && status.consolidatedId !== void 0) return `Ostatni tekst jednolity: ${status.consolidatedId}`;
	if (text === void 0) return "Tekst jednolity: brak — aktualne brzmienie to akt pierwotny z jego zmianami.";
	const asOf = text.legalStatusDate === void 0 ? "" : `, stan prawny na ${text.legalStatusDate}`;
	return `Tekst jednolity: ${journalAddress(text)} (${text.ELI}) — obwieszczenie z ${text.announcementDate ?? "?"}${asOf}, ogłoszony ${text.promulgation ?? "?"}`;
};
var SHOWN_AMENDMENTS = 10;
var amendmentLines = (status) => {
	const heading = status.consolidated === void 0 ? "Zmiany aktu" : "Zmiany po tekście jednolitym (nieujęte w nim)";
	if (status.amendmentsAfter.length === 0) return [`${heading}: brak w ELI.`];
	if (status.act.inForce === "NOT_IN_FORCE") return [`${heading}: ${String(status.amendmentsAfter.length)} — bez znaczenia dla obecnego stanu prawnego, akt nie obowiązuje.`];
	const hidden = status.amendmentsAfter.length - SHOWN_AMENDMENTS;
	return [
		`${heading}:`,
		...status.amendmentsAfter.slice(0, SHOWN_AMENDMENTS).map((amendment) => {
			const when = amendment.date === void 0 ? "data wejścia w życie nieznana" : `${amendment.pending ? "wejdzie w życie" : "w życiu od"} ${amendment.date}`;
			const title = amendment.act === void 0 ? "" : ` — ${amendment.act.title}`;
			return `- ${amendment.id} (${when})${title}`;
		}),
		...hidden > 0 ? [`- … i ${String(hidden)} więcej (--json podaje wszystkie)`] : []
	];
};
var statusJson = (status) => ({
	...status,
	citation: actCitation(citationParts(status, status.consolidated ?? status.act)),
	eli: eliUri(status.act),
	isap: isapUrl(status.act)
});
var statusMarkdown = (status) => {
	const act = status.act;
	const by = status.repealedBy.map((entry) => entry.id).join(", ");
	const repeal = act.inForce === "NOT_IN_FORCE" ? [`Uwaga: akt nie obowiązuje${act.repealDate === void 0 ? "" : ` od ${act.repealDate}`}${by === "" ? "" : `; uchylił go ${by} (prawo show ${status.repealedBy[0]?.id ?? ""})`}. Nie cytuj go jako obowiązującego.`] : [];
	return [
		`# ${act.title}`,
		`${journalAddress(act)} · ${act.ELI} · ${act.type}`,
		`Status: ${inForceLabel(act)}${act.status === void 0 ? "" : ` (${act.status})`}${act.entryIntoForce === void 0 ? "" : `; wszedł w życie ${act.entryIntoForce}`}`,
		...repeal,
		consolidatedLine(status),
		...amendmentLines(status),
		...status.unified === void 0 ? [] : [`Tekst ujednolicony Kancelarii Sejmu (bez mocy prawnej, z późniejszymi zmianami): prawo text ${act.ELI} --unified`],
		...status.tribunal.length === 0 ? [] : [`Orzeczenia TK dotyczące aktu: ${status.tribunal.map((entry) => entry.id).join(", ")}`],
		...staleLine(status.stale, status.fetchedAt),
		`Linki: ${[eliUri(act), isapUrl(act)].filter(Boolean).join(" · ")}`,
		`Cytat: ${actCitation(citationParts(status, status.consolidated ?? act))}`
	].join("\n");
};
var SOURCE_NAMES = {
	consolidated: "tekst jednolity",
	original: "tekst pierwotny",
	unified: "tekst ujednolicony (Kancelaria Sejmu, bez mocy prawnej)"
};
var sourceLine = (text) => {
	const edition = text.edition;
	return `Źródło: ${text.source === "consolidated" ? `tekst jednolity ${journalAddress(edition)} — obwieszczenie z ${edition.announcementDate ?? "?"}${edition.legalStatusDate === void 0 ? "" : `, stan prawny na ${edition.legalStatusDate}`}` : text.source === "unified" ? `${SOURCE_NAMES.unified}${text.parsed.basis === void 0 ? "" : `; ${text.parsed.basis}`}` : `${SOURCE_NAMES.original} ${journalAddress(edition)}`}; ELI ${eliUri(text.status.act)}; plik: ${text.url}`;
};
var statusLine = (status) => {
	const pending = status.amendmentsAfter.filter((amendment) => amendment.pending);
	const inForce = status.amendmentsAfter.filter((amendment) => !amendment.pending);
	const parts = [`Akt: ${inForceLabel(status.act)}`];
	if (inForce.length > 0) parts.push(`zmiany w życiu po tym tekście: ${inForce.map((amendment) => `${amendment.id} (${amendment.date ?? "?"})`).join(", ")} — sprawdź, czy dotyczą przepisu`);
	if (pending.length > 0) parts.push(`zmiany oczekujące: ${pending.map((amendment) => `${amendment.id} (od ${amendment.date ?? "?"})`).join(", ")}`);
	return [`${parts.join("; ")}.`, ...staleLine(status.stale, status.fetchedAt)].join("\n");
};
var unitLine = (unit) => `[${unit.marker}] ${unit.label === "" ? "" : `${unit.label} `}${unit.text}`.trimEnd();
var articleBlock = (article, units, notes) => [
	`### ${article.marker}`,
	...units.map(unitLine),
	...notes.map((note) => `> Przypis${note.marker === article.marker ? "" : ` (${note.marker})`}: ${note.text}`)
];
var textMarkdown = (text, articles) => {
	const out = [
		`# ${text.status.act.title}`,
		sourceLine(text),
		...text.warning === void 0 ? [] : [`Uwaga: ${text.warning}`],
		""
	];
	let heading;
	for (const article of articles) {
		if (article.heading !== void 0 && article.heading !== heading) {
			heading = article.heading;
			out.push(`## ${heading}`);
		}
		out.push(...articleBlock(article, article.units, article.notes), "");
	}
	out.push(statusLine(text.status), `Cytat: ${actCitation(citationParts(text.status, basisOf(text)))}`);
	return out.join("\n");
};
var outlineMarkdown = (text, articles, length) => {
	const out = [
		`# ${text.status.act.title}`,
		sourceLine(text),
		...text.warning === void 0 ? [] : [`Uwaga: ${text.warning}`],
		`Spis: ${String(articles.length)} jednostek, ${String(Math.round(length / 1e3))} tys. znaków. Całość: --all (najlepiej do pliku), fragment: --from/--to, przepis: prawo article ${text.status.act.ELI} <nr>.`,
		""
	];
	let heading;
	for (const article of articles) {
		if (article.heading !== void 0 && article.heading !== heading) {
			heading = article.heading;
			out.push(`## ${heading}`);
		}
		const start = article.units.map((unit) => unit.text).join(" ");
		out.push(`- ${article.marker}: ${start.length > 90 ? `${start.slice(0, 90)}…` : start}`);
	}
	return out.join("\n");
};
var articleMarkdown = (text, selections) => {
	const first = selections[0];
	const versions = selections.length > 1 ? ["Ten przepis ma w tekście kilka brzmień: przypisy mówią, które obowiązuje i od kiedy.", ""] : [];
	return [
		`## ${first?.marker ?? ""} · ${text.status.act.title}`,
		...first?.article.heading === void 0 ? [] : [first.article.heading],
		...text.warning === void 0 ? [] : [`Uwaga: ${text.warning}`],
		"",
		...versions,
		...selections.flatMap((selection) => [...articleBlock(selection.article, selection.units, selection.notes).slice(1), ""]),
		`Cytat: ${actCitation(citationParts(text.status, basisOf(text)), first?.marker)}`,
		sourceLine(text),
		statusLine(text.status)
	].join("\n");
};
var textJson = (text, selections) => ({
	act: text.status.act,
	source: text.source,
	edition: text.edition,
	format: text.format,
	url: text.url,
	warning: text.warning,
	notice: text.parsed.notice,
	basis: text.parsed.basis,
	amendmentsAfter: text.status.amendmentsAfter,
	articles: selections.map((selection) => ({
		...selection.article,
		units: selection.units,
		notes: selection.notes,
		citation: actCitation(citationParts(text.status, basisOf(text)), selection.marker)
	})),
	citation: actCitation(citationParts(text.status, basisOf(text)), selections.length === 1 ? selections[0]?.marker : void 0),
	sourceLine: sourceLine(text)
});
var COVERAGE = "SAOS: sądy powszechne na bieżąco; SN do 2016, TK do 2015, KIO do 2018; bez sądów administracyjnych (NSA i WSA: orzeczenia.nsa.gov.pl). Orzeczenia ilustrują wykładnię, nie wiążą.";
var excerpt = (hit) => (hit.textContent ?? "").replaceAll(/<em>([\s\S]*?)<\/em>/giu, "**$1**").replaceAll(/<[^>]*>/gu, " ").replaceAll(/\s+/gu, " ").trim().slice(0, 400);
var rulingsJson = (hits) => ({
	total: hits.total,
	items: hits.items.map((hit) => ({
		...hit,
		court: courtName(hit),
		citation: rulingCitation(hit),
		url: saosUrl(hit.id)
	})),
	coverage: COVERAGE
});
var rulingsMarkdown = (hits, stale) => {
	if (hits.items.length === 0) return ["Brak orzeczeń.", COVERAGE].join("\n");
	return [
		`${String(hits.total)} orzeczeń · pokazano ${String(hits.items.length)}, od najnowszych`,
		...hits.items.flatMap((hit) => [`- ${rulingCitation(hit)}`, ...excerpt(hit) === "" ? [] : [`  ${excerpt(hit)}`]]),
		...staleLine(stale),
		"Dalej: prawo rulings show <id> — treść, podstawa prawna, powołane przepisy.",
		COVERAGE
	].join("\n");
};
var SHORT_TEXT = 6e3;
var rulingJson = (judgment) => ({
	...judgment,
	textContent: void 0,
	text: htmlLines(judgment.textContent ?? "").join("\n"),
	court: courtName(judgment),
	citation: rulingCitation(judgment)
});
var rulingMarkdown = (judgment, full) => {
	const text = htmlLines(judgment.textContent ?? "").join("\n");
	const shown = full || text.length <= SHORT_TEXT ? text : `${text.slice(0, SHORT_TEXT)}\n… (skrócone: --full pokazuje całość)`;
	const regulations = (judgment.referencedRegulations ?? []).map((regulation) => `- ${regulation.text}`);
	const date = judgment.judgmentDate === void 0 || judgment.judgmentDate === null ? "" : ` · ${polishDate(judgment.judgmentDate)}`;
	return [
		`## ${courtName(judgment)}${date}`,
		...judgment.summary === void 0 || judgment.summary === null || judgment.summary === "" ? [] : [`Teza: ${judgment.summary}`],
		...(judgment.legalBases ?? []).length === 0 ? [] : [`Podstawa prawna: ${(judgment.legalBases ?? []).join("; ")}`],
		...regulations.length === 0 ? [] : ["Powołane przepisy:", ...regulations],
		...(judgment.keywords ?? []).length === 0 ? [] : [`Hasła: ${(judgment.keywords ?? []).join(", ")}`],
		"",
		shown,
		"",
		`Cytat: ${rulingCitation(judgment)}`,
		...judgment.source?.judgmentUrl === void 0 || judgment.source.judgmentUrl === null ? [] : [`Źródło sądu: ${judgment.source.judgmentUrl}`],
		"Orzeczenie ilustruje wykładnię i nie wiąże w innych sprawach; sprawdź, czy przepisy, które stosuje, nie zmieniły się od jego wydania."
	].join("\n");
};
// src/sources/eli.ts
var ReferenceSchema = object({
	id: string(),
	date: string().optional(),
	art: string().optional()
});
var ActSchema = object({
	ELI: string(),
	address: string().optional(),
	publisher: string(),
	year: number$1(),
	volume: number$1().optional(),
	pos: number$1(),
	title: string(),
	type: string(),
	displayAddress: string(),
	status: string().optional(),
	inForce: string().optional(),
	promulgation: string().optional(),
	announcementDate: string().optional(),
	entryIntoForce: string().optional(),
	validFrom: string().optional(),
	repealDate: string().optional(),
	expirationDate: string().optional(),
	legalStatusDate: string().optional(),
	changeDate: string().optional(),
	textHTML: boolean().optional(),
	textPDF: boolean().optional(),
	texts: array(object({
		fileName: string(),
		type: string()
	})).optional(),
	references: record(string(), array(ReferenceSchema)).optional()
});
var SearchPageSchema = object({
	totalCount: number$1(),
	offset: number$1().optional(),
	items: array(ActSchema)
});
var ELI_API = "https://api.sejm.gov.pl/eli";
var actId = (raw) => {
	const trimmed = raw.trim();
	const eli = /(?:^|\/eli\/(?:acts\/)?)(DU|MP)\/(\d{4})\/(\d+)/iu.exec(trimmed);
	if (eli !== null) return `${(eli[1] ?? "").toUpperCase()}/${eli[2] ?? ""}/${String(Number(eli[3]))}`;
	const isap = /^W(DU|MP)(\d{4})\d{3}(\d{4})$/iu.exec(trimmed);
	if (isap !== null) return `${(isap[1] ?? "").toUpperCase()}/${isap[2] ?? ""}/${String(Number(isap[3]))}`;
	throw new Error(`"${raw}" is not an act address: use DU/<year>/<position> or MP/<year>/<position>, e.g. DU/1960/168`);
};
var Eli = class {
	http;
	constructor(http) {
		this.http = http;
	}
	async search(query) {
		const url = new URL(`${ELI_API}/acts/search`);
		const params = {
			title: query.title,
			keyword: query.keyword,
			publisher: query.publisher,
			year: query.year,
			type: query.type,
			inForce: query.inForce === true ? "1" : void 0,
			limit: String(query.limit),
			offset: query.offset === void 0 ? void 0 : String(query.offset)
		};
		for (const [key, value] of Object.entries(params)) if (value !== void 0 && value !== "") url.searchParams.set(key, value);
		return await this.http.json(url.toString(), SearchPageSchema);
	}
	async act(id) {
		return await this.http.json(`${ELI_API}/acts/${id}`, ActSchema);
	}
	async html(id) {
		const html = await this.http.text(`${ELI_API}/acts/${id}/text.html`);
		return html.trim() === "" ? void 0 : html;
	}
	async pdf(id, file) {
		const path = file === void 0 ? "text.pdf" : `text/${file.type}/${encodeURIComponent(file.fileName)}`;
		return await this.http.bytes(`${ELI_API}/acts/${id}/${path}`);
	}
};
// src/cli.ts
var USAGE = `prawo — Polish acts (Sejm ELI: Dziennik Ustaw, Monitor Polski) and court rulings (SAOS), with citations.

  prawo search <words of the title> [--keyword K] [--type Ustawa|Rozporządzenie|…] [--year YYYY]
               [--publisher DU|MP] [--in-force | --repealed] [--limit N]
  prawo show <DU/2010/1131>                in force?, newest consolidated text, amendments after it
  prawo article <DU/1960/168> <35 § 1>     one article or a unit of it ("31 ust. 2 pkt 3", "22[1]", "§ 4" in a regulation)
  prawo text <DU/1960/168> [--from 35] [--to 38] [--all]   a long act prints its outline unless narrowed or --all
      --original    the act as first published, not the consolidated text
      --unified     the Chancellery's unified text: current, but without legal force
  prawo rulings search <phrase> [--act DU/1960/168] [--regulation "art. 35"] [--legal-base TEXT]
                       [--case "I ACa 772/13"] [--court common|supreme|tribunal|kio] [--from DATE] [--to DATE] [--limit N]
  prawo rulings show <SAOS id> [--full]

  --json      the same facts as JSON
  --refresh   ask the sources again instead of the cached copy
Texts are kept in the workspace cache, so an act read once can be quoted offline.`;
var print = (args, json, markdown) => has(args, "json") ? JSON.stringify(json(), void 0, 1) : markdown();
var required = (value, what) => {
	if (value === void 0 || value.trim() === "") throw new UsageError(`${what} is required (prawo --help)`);
	return value;
};
var search = async (args, law, settings) => {
	const title = args.positional.slice(1).join(" ");
	const keyword = flag(args, "keyword");
	if (title === "" && keyword === void 0) throw new UsageError("give words of the title, or --keyword");
	if (has(args, "in-force") && has(args, "repealed")) throw new UsageError("--in-force and --repealed exclude each other");
	const publisher = flag(args, "publisher")?.toUpperCase();
	if (publisher !== void 0 && publisher !== "DU" && publisher !== "MP") throw new UsageError("--publisher is DU (Dziennik Ustaw) or MP (Monitor Polski)");
	const result = await law.search({
		title,
		keyword,
		publisher,
		year: flag(args, "year"),
		type: flag(args, "type"),
		inForce: has(args, "in-force"),
		repealed: has(args, "repealed"),
		limit: limitOf(args, settings.limit)
	});
	return print(args, () => searchJson(result), () => searchMarkdown(result));
};
var show = async (args, law) => {
	const status = await law.status(required(args.positional[1], "an act, e.g. DU/1960/168,"));
	return print(args, () => statusJson(status), () => statusMarkdown(status));
};
var preferOf = (args) => {
	if (has(args, "original") && has(args, "unified")) throw new UsageError("--original and --unified exclude each other");
	return has(args, "original") ? "original" : has(args, "unified") ? "unified" : void 0;
};
var text = async (args, law) => {
	const result = await law.text(actId(required(args.positional[1], "an act, e.g. DU/1960/168,")), preferOf(args));
	const { articles } = result.parsed;
	const from = flag(args, "from");
	const to = flag(args, "to");
	for (const bound of [from, to]) if (bound !== void 0 && findArticle(result.parsed, articleKey(bound)) === void 0) throw new UsageError(`${bound} is not an article of ${result.edition.ELI} (prawo text without --from/--to lists them)`);
	const fromKey = from === void 0 ? void 0 : articleKey(from);
	const toKey = to === void 0 ? void 0 : articleKey(to);
	const start = fromKey === void 0 ? 0 : articles.findIndex((candidate) => candidate.number === fromKey);
	const end = toKey === void 0 ? articles.length - 1 : articles.findLastIndex((candidate) => candidate.number === toKey);
	const chosen = articles.slice(start, end + 1);
	return print(args, () => textJson(result, chosen.map((article) => ({
		article,
		units: article.units,
		notes: article.notes,
		marker: article.marker
	}))), () => {
		const whole = textMarkdown(result, chosen);
		return from === void 0 && to === void 0 && !has(args, "all") && whole.length > WHOLE_TEXT_LIMIT ? outlineMarkdown(result, chosen, whole.length) : whole;
	});
};
var WHOLE_TEXT_LIMIT = 4e4;
var selectionsOf = (result, address) => {
	const { article, rest } = parseAddress(address);
	const versions = result.parsed.articles.filter((candidate) => candidate.number === article);
	if (versions.length === 0) {
		const near = result.parsed.articles.map((candidate) => candidate.number).filter((number) => number.startsWith(article.replace(/^(z[^:]*:)?(\d*).*$/u, "$1$2"))).slice(0, 8);
		throw new UsageError(`no article ${article} in ${result.edition.ELI}${near.length > 0 ? `; nearby: ${near.join(", ")}` : ""} (a repealed article may be missing from the text; prawo text ${result.status.act.ELI} lists them)`);
	}
	const selections = versions.map((version) => ({
		article: version,
		units: selectUnits(version, rest),
		notes: notesFor(version, rest),
		marker: rest === "" ? version.marker : `${version.marker} ${rest}`
	}));
	if (selections.every((selection) => selection.units.length === 0)) throw new UsageError(`${selections[0]?.marker ?? address} is not in ${versions[0]?.marker ?? article}; its units are: ${(versions[0]?.units ?? []).map((unit) => unit.marker).join(", ")}`);
	return selections.filter((selection) => selection.units.length > 0);
};
var article = async (args, law) => {
	const id = actId(required(args.positional[1], "an act, e.g. DU/1960/168,"));
	const address = required(args.positional.slice(2).join(" "), "an article, e.g. 35 or \"35 § 1\",");
	const result = await law.text(id, preferOf(args));
	const selections = selectionsOf(result, address);
	return print(args, () => textJson(result, selections), () => articleMarkdown(result, selections));
};
var COURTS = /* @__PURE__ */ new Map([
	["common", "COMMON"],
	["supreme", "SUPREME"],
	["tribunal", "CONSTITUTIONAL_TRIBUNAL"],
	["kio", "NATIONAL_APPEAL_CHAMBER"],
	["administrative", "ADMINISTRATIVE"]
]);
var rulings = async (args, law, settings) => {
	const sub = args.positional[1];
	if (sub === "show") {
		const id = Number(required(args.positional[2], "a SAOS ruling id"));
		if (!Number.isInteger(id) || id < 1) throw new UsageError(`a SAOS ruling id is a number, got "${args.positional[2] ?? ""}"`);
		const judgment = await law.ruling(id);
		return print(args, () => rulingJson(judgment.value), () => rulingMarkdown(judgment.value, has(args, "full")));
	}
	if (sub !== "search") throw new UsageError("use prawo rulings search <phrase> or prawo rulings show <id>");
	const court = flag(args, "court");
	const courtType = court === void 0 ? void 0 : COURTS.get(court.toLowerCase());
	if (court !== void 0 && courtType === void 0) throw new UsageError(`--court is one of ${[...COURTS.keys()].join(", ")}`);
	const act = flag(args, "act");
	const lawJournalEntryCode = act === void 0 ? void 0 : journalEntry(act);
	const all = args.positional.slice(2).join(" ");
	const legalBase = flag(args, "legal-base");
	const referencedRegulation = flag(args, "regulation");
	const caseNumber = flag(args, "case");
	if ([
		all,
		legalBase,
		referencedRegulation,
		caseNumber,
		lawJournalEntryCode
	].every((value) => value === void 0 || value === "")) throw new UsageError("give a phrase, or --act, --regulation, --legal-base or --case");
	const hits = await law.rulings({
		all,
		legalBase,
		referencedRegulation,
		lawJournalEntryCode,
		caseNumber,
		courtType,
		judgmentDateFrom: dateOf(args, "from"),
		judgmentDateTo: dateOf(args, "to") ?? settings.today,
		pageSize: limitOf(args, settings.limit)
	});
	return print(args, () => rulingsJson(hits.value), () => rulingsMarkdown(hits.value, hits.stale));
};
var journalEntry = (raw) => {
	const id = actId(raw);
	if (!id.startsWith("DU/")) throw new UsageError("--act links rulings through Dziennik Ustaw only (DU/<year>/<position>)");
	return id.slice(3);
};
var COMMANDS = /* @__PURE__ */ new Map([
	["search", search],
	["show", show],
	["text", text],
	["article", article],
	["rulings", rulings]
]);
var execute = async (argv, law, settings) => {
	try {
		const args = parseArgs(argv);
		const command = COMMANDS.get(args.positional[0] ?? "");
		if (command === void 0 || has(args, "help")) {
			const known = args.positional[0] === void 0 || has(args, "help");
			return {
				code: known ? 0 : 2,
				text: known ? USAGE : `unknown command "${args.positional[0] ?? ""}"\n\n${USAGE}`
			};
		}
		return {
			code: 0,
			text: await command(args, law, settings)
		};
	} catch (error) {
		return {
			code: 2,
			text: `prawo: ${errorMessage(error)}`
		};
	}
};
// src/sources/saos.ts
var CourtCaseSchema = object({ caseNumber: string() });
var DivisionSchema = object({
	name: string().nullish(),
	court: object({ name: string().nullish() }).nullish(),
	chambers: array(object({ name: string() })).nullish()
});
var HitSchema = object({
	id: number$1(),
	courtType: string(),
	courtCases: array(CourtCaseSchema).nullish(),
	judgmentType: string().nullish(),
	judgmentDate: string().nullish(),
	textContent: string().nullish(),
	keywords: array(string()).nullish(),
	division: DivisionSchema.nullish()
});
var JudgmentSchema = HitSchema.extend({
	summary: string().nullish(),
	decision: string().nullish(),
	legalBases: array(string()).nullish(),
	referencedRegulations: array(object({
		journalTitle: string().nullish(),
		journalYear: number$1().nullish(),
		journalEntry: number$1().nullish(),
		text: string()
	})).nullish(),
	source: object({
		judgmentUrl: string().nullish(),
		publicationDate: string().nullish()
	}).nullish()
});
var SearchSchema = object({
	items: array(HitSchema),
	info: object({ totalResults: number$1() }).optional()
});
var SAOS_API = "https://www.saos.org.pl/api";
var Saos = class {
	http;
	constructor(http) {
		this.http = http;
	}
	async search(query) {
		const url = new URL(`${SAOS_API}/search/judgments`);
		for (const [key, value] of Object.entries(query)) if (value !== void 0 && value !== "") url.searchParams.set(key, String(value));
		url.searchParams.set("sortingField", "JUDGMENT_DATE");
		url.searchParams.set("sortingDirection", "DESC");
		const page = await this.http.json(url.toString(), SearchSchema);
		return {
			items: page.items,
			total: page.info?.totalResults ?? page.items.length
		};
	}
	async judgment(id) {
		return (await this.http.json(`${SAOS_API}/judgments/${String(id)}`, object({ data: JudgmentSchema }))).data;
	}
};
// src/text/pdf.ts
var RUNNING_HEAD = [/^(?:Dziennik Ustaw|Monitor Polski)(?:\s+Nr\s+\d+)?\s+[–—-]\s+\d+\s+[–—-]\s+Poz\.\s+\d+$/u, /^©\s*Kancelaria Sejmu\s+s\.\s+\d+\/\d+$/u];
var GLUED_REF = /(?<=[\p{L}.,;:)”’])(\d{1,3})\)(?=[\s,.;:)]|$)/gu;
var STRUCTURAL = /^(?:Art\.\s*\d|§\s*\d|\d+[a-z]*[.)]\s|[a-z]{1,2}\)\s|[–-]\s)/u;
var FOOTNOTE_START = /^(\d{1,3})\)\s+(.*)$/u;
var BROKEN_WORD = /\p{L}-$/u;
var glue = (before, after) => BROKEN_WORD.test(before) ? before.slice(0, -1) + after : `${before} ${after}`.trim();
var pagesOf = (markdown) => markdown.split(/^## Page \d+\s*$/mu).slice(/^## Page \d+\s*$/mu.test(markdown) ? 1 : 0).map((page) => page.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !RUNNING_HEAD.some((head) => head.test(line))).map((text) => ({
	kind: "line",
	text
}))).filter((lines) => lines.length > 0);
var MARGIN_LINE = 24;
var textOf = (entry) => entry?.kind === "line" ? entry.text : void 0;
var isMarginLine = (entry) => {
	const line = textOf(entry);
	return line !== void 0 && line.length <= MARGIN_LINE && !STRUCTURAL.test(line) && !HEADING.test(line);
};
var marginNotes = (entries) => {
	const out = [];
	let index = 0;
	while (index < entries.length) {
		let end = index;
		while (isMarginLine(entries[end]) && (end > index || /^\p{Lu}/u.test(textOf(entries[end]) ?? ""))) end += 1;
		if (end - index >= 3) {
			out.push({
				kind: "note",
				note: entries.slice(index, end).map((entry) => textOf(entry) ?? "").reduce(glue)
			});
			index = end;
		} else {
			out.push(entries[index] ?? {
				kind: "line",
				text: ""
			});
			index += 1;
		}
	}
	return out;
};
var gluedRefs = (text) => [...text.matchAll(GLUED_REF)].map((match) => Number(match[1]));
var footnotesFrom = (entries, start, first, waiting) => {
	const notes = /* @__PURE__ */ new Map();
	let expected = first;
	for (const entry of entries.slice(start)) {
		if (entry.kind === "note") continue;
		const numbered = FOOTNOTE_START.exec(entry.text);
		if (numbered === null) {
			notes.set(expected - 1, glue(notes.get(expected - 1) ?? "", entry.text));
			continue;
		}
		if (Number(numbered[1]) !== expected || !waiting.includes(expected)) return;
		notes.set(expected, numbered[2] ?? "");
		expected += 1;
	}
	return notes;
};
var footBlock = (entries, waiting) => {
	const lastRef = entries.findLastIndex((entry) => gluedRefs(textOf(entry) ?? "").length > 0);
	for (let start = lastRef + 1; start < entries.length; start += 1) {
		const head = FOOTNOTE_START.exec(textOf(entries[start]) ?? "");
		const first = Number(head?.[1]);
		if (head !== null && waiting.includes(first) && /^\p{Lu}/u.test(head[2] ?? "")) {
			const notes = footnotesFrom(entries, start, first, waiting);
			if (notes !== void 0) return {
				start,
				notes
			};
		}
	}
};
var cleanPages = (markdown, unified) => {
	const footnotes = /* @__PURE__ */ new Map();
	const lines = [];
	let waiting = [];
	for (const page of pagesOf(markdown)) {
		const entries = unified ? marginNotes(page) : page;
		const fresh = entries.flatMap((entry) => gluedRefs(textOf(entry) ?? ""));
		waiting = [.../* @__PURE__ */ new Set([...waiting, ...fresh])].filter((ref) => !footnotes.has(ref)).toSorted((a, b) => a - b);
		const block = footBlock(entries, waiting);
		for (const [ref, note] of block?.notes ?? []) footnotes.set(ref, note.trim());
		const found = Math.max(0, ...block?.notes.keys() ?? []);
		waiting = waiting.filter((ref) => !footnotes.has(ref) && ref > found);
		entries.forEach((entry, index) => {
			if (entry.kind === "note") lines.push({
				text: "",
				refs: [],
				note: entry.note
			});
			else if (block === void 0 || index < block.start) lines.push({
				text: entry.text.replace(GLUED_REF, ""),
				refs: gluedRefs(entry.text)
			});
		});
	}
	return {
		lines,
		footnotes
	};
};
var HEADING = /^(?:DZIAŁ|Dział|ROZDZIAŁ|Rozdział|ODDZIAŁ|Oddział|TYTUŁ|Tytuł|KSIĘGA|Księga|CZĘŚĆ|Część)\s+(?:[IVXLCDM]+[A-Za-z]{0,2}|\d+[A-Za-z]{0,2}|[A-ZĄĆĘŁŃÓŚŹŻ]{4,})$/u;
var HEADING_RANKS = [
	"księga",
	"część",
	"tytuł",
	"dział",
	"rozdział",
	"oddział"
];
var ANNEX_START = /^Załącznik do obwieszczenia/u;
var BASIS = /^Opracowano na podstawie/u;
var CITED_ACT_CHANGES = /^Zmian[ay]\b.*\bwymienion/u;
var ANNEX = /^Załącznik(i)?(?:\s+nr\s+(\d+[a-z]?))?(?:\s+do\s+(.*[^;,:]))?$/u;
var SUB_ANNEX = /^(?:instrukcji|załącznika|wzoru|regulaminu|statutu)\b/iu;
var ARTICLE = /^Art\.\s*(\d+)(?:\[([0-9a-z]+)\])?([a-z]{0,4})(?:\s*[–-]\s*(\d+)(?:\[[0-9a-z]+\])?[a-z]{0,4})?\.\s*(.*)$/u;
var PARAGRAPH = /^§\s*(\d+[a-z]{0,4})\.\s*(.*)$/u;
var baseOf = (key) => key === void 0 ? void 0 : /^(\d+)/u.exec(key.split("-").at(-1) ?? "")?.[1];
var placeOf = (key) => {
	const match = /^(\d+)(?:\^([0-9a-z]+))?([a-z]*)$/u.exec(key.split("-").at(-1) ?? key);
	return [
		Number(match?.[1]),
		match?.[2] ?? "",
		match?.[3] ?? ""
	];
};
var inOrder = (next, previous) => {
	if (previous === void 0) return true;
	const [nextBase, nextRaised, nextLetters] = placeOf(next);
	const [previousBase, previousRaised, previousLetters] = placeOf(previous);
	if (nextBase !== previousBase) return nextBase > previousBase;
	const raised = nextRaised.localeCompare(previousRaised, "en", { numeric: true });
	return raised === 0 ? nextLetters >= previousLetters : raised > 0;
};
var raisedTail = (base, previousBase) => {
	const tail = base.slice(previousBase.length);
	return base.startsWith(previousBase) && /^[1-9]\d?$/u.test(tail) ? tail : void 0;
};
var articleNumber = (match, previous, nextOutside) => {
	const [, base = "", raised, letters = "", rangeEnd] = match;
	const previousBase = baseOf(previous);
	const tail = previousBase === void 0 || raised !== void 0 || letters !== "" || rangeEnd !== void 0 ? void 0 : raisedTail(base, previousBase);
	const following = tail === void 0 || previousBase === void 0 ? void 0 : nextOutside(previousBase);
	const key = rangeEnd !== void 0 ? `${base}-${rangeEnd}` : following !== void 0 && following < Number(base) ? `${previousBase ?? ""}^${tail ?? ""}` : `${base}${raised === void 0 ? "" : `^${raised}`}${letters}`;
	return inOrder(key.split("-")[0] ?? key, previous) ? key : void 0;
};
var closes = (previous) => /(?:[.:;,)–]|\s(?:albo|lub|oraz|i|bądź|a także))$/u.test(previous);
var RULES = [
	{
		level: "par",
		pattern: PARAGRAPH,
		label: (value) => `§ ${value}.`,
		accepts: (builder, value) => follows(value, builder.current("par"))
	},
	{
		level: "ust",
		pattern: /^(\d+[a-z]{0,4})\.\s+(.*)$/u,
		label: (value) => `${value}.`,
		accepts: (builder, value, previous) => closes(previous) && follows(value, builder.current("ust"))
	},
	{
		level: "pkt",
		pattern: /^(\d+[a-z]{0,4})\)\s*(.*)$/u,
		label: (value) => `${value})`,
		accepts: (builder, value, previous) => closes(previous) && follows(value, builder.current("pkt"))
	},
	{
		level: "lit",
		pattern: /^([a-z]{1,2})\)\s+(.*)$/u,
		label: (value) => `${value})`,
		accepts: (builder, value, previous) => closes(previous) && builder.current("pkt") !== void 0 && follows(value, builder.current("lit"))
	},
	{
		level: "tiret",
		pattern: /^([–-])\s+(.*)$/u,
		label: () => "–",
		accepts: (_, __, previous) => /[:;]$/u.test(previous)
	}
];
var subdivide = (builder, text, previous, top) => {
	for (const rule of RULES.filter((candidate) => top === "art" || candidate.level !== "par")) {
		const match = rule.pattern.exec(text);
		const value = rule.level === "tiret" ? "" : match?.[1] ?? "";
		if (match !== null && rule.accepts(builder, value, previous)) {
			builder.write(builder.open(rule.level, value, rule.label(value)), match[2] ?? "");
			return true;
		}
	}
	return false;
};
var Assembler = class {
	top;
	footnotes;
	bases;
	annex;
	articles = [];
	headings = [];
	builder;
	collecting;
	previous = "";
	index = 0;
	constructor(top, footnotes, bases, annex) {
		this.top = top;
		this.footnotes = footnotes;
		this.bases = bases;
		this.annex = annex;
	}
	feed(line, index) {
		this.index = index;
		if (line.note !== void 0) {
			if (!BASIS.test(line.note)) this.builder?.note(line.note, true);
			return;
		}
		const started = this.start(line.text);
		if (HEADING.test(line.text)) {
			this.finish();
			this.collecting = {
				key: line.text.split(/\s+/u)[0]?.toLowerCase() ?? "",
				parts: [line.text]
			};
		} else if (started !== void 0) this.open(started, line);
		else if (this.collecting !== void 0) this.collecting.parts.push(line.text);
		else if (this.builder !== void 0) {
			if (!subdivide(this.builder, line.text, this.previous, this.top)) this.builder.continue(line.text);
			for (const note of this.notesOf(line.refs)) this.builder.note(note);
		}
		this.previous = line.text;
	}
	finish() {
		if (this.builder !== void 0) this.articles.push(this.builder.build());
		this.builder = void 0;
		if (this.collecting !== void 0) {
			const rank = HEADING_RANKS.indexOf(this.collecting.key);
			const outer = this.headings.filter((heading) => HEADING_RANKS.indexOf(heading.key) < rank);
			this.headings.splice(0, this.headings.length, ...outer, {
				key: this.collecting.key,
				text: this.collecting.parts.join(" — ")
			});
			this.collecting = void 0;
		}
	}
	open(started, line) {
		this.finish();
		const heading = this.headings.map((entry) => entry.text).join(" / ");
		const key = this.annex === void 0 ? started.key : `z${this.annex}:${started.key}`;
		const marker = `${this.annex === void 0 ? "" : `Załącznik nr ${this.annex} `}${articleMarker(this.top, started.key)}`;
		this.builder = new ArticleBuilder(key, marker, heading === "" ? void 0 : heading);
		for (const note of this.notesOf(line.refs)) this.builder.note(note, true);
		if (started.rest !== "" && !subdivide(this.builder, started.rest, ".", this.top)) this.builder.write(void 0, started.rest);
	}
	start(text) {
		const last = (this.builder?.number ?? this.articles.at(-1)?.number)?.replace(/^z[^:]*:/u, "");
		if (this.top === "par") {
			const match = PARAGRAPH.exec(text);
			return match !== null && follows(match[1] ?? "", last) ? {
				key: match[1] ?? "",
				rest: match[2] ?? ""
			} : void 0;
		}
		const match = ARTICLE.exec(text);
		const key = match === null ? void 0 : articleNumber(match, last, (family) => this.nextOutside(family));
		return match === null || key === void 0 ? void 0 : {
			key: articleKey(key),
			rest: match[5] ?? ""
		};
	}
	nextOutside(family) {
		const next = this.bases.slice(this.index + 1).find((base) => base !== void 0 && raisedTail(base, family) === void 0);
		return next === void 0 ? void 0 : Number(next);
	}
	notesOf(refs) {
		return refs.flatMap((ref) => {
			const note = this.footnotes.get(ref);
			return note === void 0 || CITED_ACT_CHANGES.test(note) ? [] : [`${String(ref)}) ${note}`];
		});
	}
};
var topUnitOf = (lines) => {
	if (lines.some((line) => ARTICLE.test(line.text))) return "art";
	return lines.some((line) => PARAGRAPH.test(line.text)) ? "par" : void 0;
};
var FIRST_PROVISION = /^(?:Art\.|§)\s*1\.\s/u;
var partsOf = (body) => {
	const parts = [{ lines: [] }];
	let skipping = false;
	for (const line of body) {
		const annex = ANNEX.exec(line.text);
		if (annex !== null) {
			const begun = parts.at(-1)?.lines.some((entry) => FIRST_PROVISION.test(entry.text)) === true;
			const sub = annex[1] === void 0 && SUB_ANNEX.test(annex[3] ?? "");
			skipping = sub ? begun || skipping : false;
			if (annex[1] === void 0 && !sub) parts.push({
				annex: annex[2] ?? "1",
				lines: []
			});
			continue;
		}
		if (!skipping) parts.at(-1)?.lines.push(line);
	}
	return parts;
};
var tidy = (article) => ({
	...article,
	units: article.units.map((unit) => ({
		...unit,
		text: unit.text.replaceAll(/\s+/gu, " ").trim()
	}))
});
var articlesFromPdfText = (markdown, options = {}) => {
	const { lines, footnotes } = cleanPages(markdown, options.unified === true);
	const annex = lines.findIndex((line) => ANNEX_START.test(line.text));
	const articles = partsOf(annex >= 0 ? lines.slice(annex + 1) : lines).flatMap((part) => {
		const top = topUnitOf(part.lines);
		if (top === void 0) return [];
		const assembler = new Assembler(top, footnotes, part.lines.map((line) => ARTICLE.exec(line.text)?.[1]), part.annex);
		part.lines.forEach((line, index) => assembler.feed(line, index));
		assembler.finish();
		return assembler.articles;
	});
	const notice = annex >= 0 ? lines.slice(0, annex).map((line) => line.text).join(" ").replaceAll(/\s+/gu, " ").trim() : void 0;
	const basis = lines.find((line) => line.note !== void 0 && BASIS.test(line.note))?.note;
	return {
		articles: articles.map(tidy),
		notice,
		basis
	};
};
// src/law/law.ts
var HOUR = 36e5;
var METADATA_AGE = 12 * HOUR;
var SEARCH_AGE = HOUR;
var READER_VERSION = 5;
var UnitSchema = object({
	marker: string(),
	label: string(),
	text: string()
});
var ParsedTextSchema = object({
	articles: array(object({
		number: string(),
		marker: string(),
		heading: string().optional(),
		units: array(UnitSchema),
		notes: array(object({
			marker: string(),
			text: string()
		}))
	})),
	notice: string().optional(),
	basis: string().optional()
});
var StoredTextSchema = object({
	format: _enum(["html", "pdf"]),
	url: string(),
	parsed: ParsedTextSchema
});
var HitsSchema = object({
	items: array(HitSchema),
	total: number$1()
});
var AMENDING = /\bo zmianie\b|\bzmieniając[aey]\b/iu;
var kindOf = (act) => {
	if (act.type === "Obwieszczenie" && /jednolitego tekstu/iu.test(act.title)) return "consolidated";
	return AMENDING.test(act.title) ? "amendment" : "act";
};
var subjectOf = (title) => title.replace(/^.*?\d{4}\s*r\.\s*(?:[–-]\s*)?/u, "").replace(/\.$/u, "").toLowerCase();
var rank = (query, hits) => {
	const wanted = query.trim().toLowerCase();
	const score = (hit) => (hit.kind === "act" ? 0 : 4) + (wanted !== "" && subjectOf(hit.act.title) === wanted ? 0 : 2) + (hit.act.inForce === "IN_FORCE" ? 0 : 1);
	return hits.toSorted((a, b) => score(a) - score(b) || b.act.year - a.act.year || b.act.pos - a.act.pos);
};
var byNewest = (a, b) => b.id.localeCompare(a.id, "en", { numeric: true });
var stems = (title) => title.split(/\s+/u).map((word) => word.length > 5 ? word.slice(0, -3) : word).join(" ");
var Law = class {
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	async search(query) {
		const found = await this.searchAs(query);
		const title = query.title ?? "";
		if (found.total > 0 || stems(title) === title) return found;
		return {
			...await this.searchAs({
				...query,
				title: stems(title)
			}),
			stemmed: stems(title)
		};
	}
	async searchAs(query) {
		const pages = [];
		let stale;
		for (let offset = 0; offset < 500; offset += 100) {
			const page = await this.cachedSearch({
				...query,
				limit: 100,
				offset
			});
			stale ??= page.stale;
			pages.push(page.value);
			const seen = pages.reduce((count, entry) => count + entry.items.length, 0);
			const repealed = pages.flatMap((entry) => entry.items).filter((act) => act.inForce === "NOT_IN_FORCE").length;
			if (query.repealed !== true || repealed >= query.limit || seen >= page.value.totalCount || page.value.items.length === 0) break;
		}
		const items = pages.flatMap((page) => page.items).filter((act) => query.repealed !== true || act.inForce === "NOT_IN_FORCE").map((act) => ({
			act,
			kind: kindOf(act)
		}));
		return {
			total: query.repealed === true ? items.length : pages[0]?.totalCount ?? 0,
			items: rank(query.title ?? "", items).slice(0, query.limit),
			stale
		};
	}
	async status(raw, forText = false) {
		const id = actId(raw);
		const cached = await this.act(id);
		const act = cached.value;
		const repealed = act.inForce === "NOT_IN_FORCE";
		const latest = (act.references?.["Inf. o tekście jednolitym"] ?? []).toSorted(byNewest)[0];
		const consolidated = latest === void 0 || repealed && !forText ? void 0 : (await this.act(latest.id)).value;
		const cutoff = consolidated?.legalStatusDate ?? consolidated?.announcementDate;
		const today = this.deps.today();
		const after = (act.references?.["Akty zmieniające"] ?? []).filter((reference) => cutoff === void 0 || reference.date === void 0 || reference.date > cutoff).toSorted((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
		const amendmentsAfter = await Promise.all(after.map(async (reference, index) => ({
			id: reference.id,
			date: reference.date,
			pending: reference.date !== void 0 && reference.date > today,
			act: index < 8 && !repealed ? await this.titleOf(reference.id) : void 0
		})));
		const unified = act.texts?.find((file) => file.type === "U");
		return {
			act,
			consolidated,
			consolidatedId: latest?.id,
			amendmentsAfter,
			repealedBy: [...act.references?.["Akty uchylające"] ?? [], ...act.references?.["Uchylenia wynikające z"] ?? []],
			tribunal: act.references?.["Orzeczenie TK"] ?? [],
			unified,
			fetchedAt: cached.savedAt,
			stale: cached.stale
		};
	}
	async text(raw, prefer) {
		const status = await this.status(raw, true);
		const inForceAmendments = status.amendmentsAfter.some((amendment) => !amendment.pending);
		const source = prefer ?? (status.consolidated !== void 0 ? "consolidated" : inForceAmendments && status.unified !== void 0 ? "unified" : "original");
		const edition = source === "consolidated" && status.consolidated !== void 0 ? status.consolidated : status.act;
		if (source === "unified" && status.unified === void 0) throw new Error(`${status.act.ELI} has no unified text (tekst ujednolicony) in the Sejm's database`);
		const key = `texts/${source}/${edition.ELI}/v${String(READER_VERSION)}${source === "unified" ? `/${status.act.changeDate ?? ""}` : ""}`;
		const stored = await this.deps.cache.through(key, StoredTextSchema, async () => await this.fetchText(edition, source, status));
		const warning = source === "unified" ? "Tekst ujednolicony Kancelarii Sejmu: aktualny, ale bez mocy prawnej; cytuj tekst jednolity i zmiany." : source === "original" && (status.consolidated !== void 0 || status.amendmentsAfter.length > 0) ? "To pierwotne brzmienie aktu, bez późniejszych zmian: nie cytuj go jako obowiązującego." : void 0;
		return {
			status,
			source,
			edition,
			...stored.value,
			warning
		};
	}
	async rulings(query) {
		const url = JSON.stringify(query);
		const key = `rulings-search/${createHash("sha1").update(url).digest("hex")}`;
		return await this.deps.cache.through(key, HitsSchema, async () => await this.deps.saos.search(query), {
			maxAgeMs: SEARCH_AGE,
			refresh: this.deps.refresh
		});
	}
	async ruling(id) {
		return await this.deps.cache.through(`rulings/${String(id)}`, JudgmentSchema, async () => await this.deps.saos.judgment(id), {
			maxAgeMs: 720 * HOUR,
			refresh: this.deps.refresh
		});
	}
	async titleOf(id) {
		try {
			return (await this.act(id)).value;
		} catch {
			return;
		}
	}
	async act(id) {
		return await this.deps.cache.through(`acts/${id}`, ActSchema, async () => await this.deps.eli.act(id), {
			maxAgeMs: METADATA_AGE,
			refresh: this.deps.refresh
		});
	}
	async cachedSearch(query) {
		const key = `search/${createHash("sha1").update(JSON.stringify(query)).digest("hex")}`;
		return await this.deps.cache.through(key, SearchPageSchema, async () => await this.deps.eli.search(query), {
			maxAgeMs: SEARCH_AGE,
			refresh: this.deps.refresh
		});
	}
	async fetchText(edition, source, status) {
		const base = `${ELI_API}/acts/${edition.ELI}`;
		if (source === "unified" && status.unified !== void 0) {
			const text = await this.deps.pdfText(await this.deps.eli.pdf(edition.ELI, status.unified));
			return {
				format: "pdf",
				url: `${base}/text/U/${status.unified.fileName}`,
				parsed: this.articles(articlesFromPdfText(text, { unified: true }), base)
			};
		}
		const html = edition.textHTML === true ? await this.deps.eli.html(edition.ELI) : void 0;
		const fromHtml = html === void 0 ? void 0 : articlesFromHtml(html);
		if (fromHtml !== void 0 && fromHtml.articles.length > 0) return {
			format: "html",
			url: `${base}/text.html`,
			parsed: fromHtml
		};
		const text = await this.deps.pdfText(await this.deps.eli.pdf(edition.ELI));
		return {
			format: "pdf",
			url: `${base}/text.pdf`,
			parsed: this.articles(articlesFromPdfText(text), base)
		};
	}
	articles(parsed, url) {
		if (parsed.articles.length === 0) throw new Error(`no articles could be read from ${url}: open it with \`fileq read\` and quote it by hand`);
		return parsed;
	}
};
// node_modules/.pnpm/@intentic+base@1.430.0/node_modules/@intentic/base/dist/web/capped-read.js
var join$1 = (chunks, size) => {
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
};
var readCappedBytes = async (response, maxBytes, options = {}) => {
	if (response.body === null) return {
		bytes: /* @__PURE__ */ new Uint8Array(),
		truncated: false
	};
	const deadline = options.timeoutMs === void 0 ? Infinity : Date.now() + options.timeoutMs;
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	const stop = async (bytes) => {
		await reader.cancel().catch(() => void 0);
		return {
			bytes,
			truncated: true
		};
	};
	for (;;) {
		if (Date.now() > deadline) return await stop(join$1(chunks, size));
		const { done, value } = await reader.read();
		if (done) return {
			bytes: join$1(chunks, size),
			truncated: false
		};
		if (size + value.byteLength > maxBytes) {
			chunks.push(value.subarray(0, maxBytes - size));
			return await stop(join$1(chunks, maxBytes));
		}
		chunks.push(value);
		size += value.byteLength;
	}
};
var readCappedText = async (response, maxBytes, options = {}) => {
	const { bytes, truncated } = await readCappedBytes(response, maxBytes, options);
	return {
		text: new TextDecoder().decode(bytes),
		truncated
	};
};
var ERROR_BODY_CHARS = 300;
var FetchJsonError = class extends Error {
	kind;
	url;
	status;
	body;
	constructor(message, kind, url, status, body, options) {
		super(message, options);
		this.kind = kind;
		this.url = url;
		this.status = status;
		this.body = body;
		this.name = "FetchJsonError";
	}
};
var sentInit = (init, signal) => {
	const headers = new Headers(init.headers);
	const sent = {
		headers,
		signal
	};
	if (init.method !== void 0) sent.method = init.method;
	if (init.json !== void 0) {
		if (!headers.has("content-type")) headers.set("content-type", "application/json");
		sent.body = JSON.stringify(init.json);
	} else if (init.body !== void 0) sent.body = init.body;
	if (!headers.has("accept")) headers.set("accept", "application/json");
	return sent;
};
var bodyExcerpt = (text, limit = ERROR_BODY_CHARS) => {
	const flat = text.replaceAll(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};
var failureOf = (error, label, url, timeout, caller, timeoutMs) => {
	if (timeout.aborted) return new FetchJsonError(`${label} timed out after ${timeoutMs}ms`, "timeout", url, void 0, void 0, { cause: error });
	if (caller?.aborted === true) return new FetchJsonError(`${label} was aborted`, "aborted", url, void 0, void 0, { cause: error });
	return new FetchJsonError(`${label} could not be reached: ${errorMessage(error)}`, "transport", url, void 0, void 0, { cause: error });
};
var fetchJsonResponse = async (url, init = {}) => {
	const href = String(url);
	const label = init.label ?? `${init.method ?? "GET"} ${href}`;
	const timeoutMs = init.timeoutMs ?? 3e4;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = init.signal === void 0 ? timeout : AbortSignal.any([init.signal, timeout]);
	const call = init.fetch ?? fetch;
	let response;
	let text;
	try {
		response = await call(href, sentInit(init, signal));
		text = response.ok || (init.accept ?? []).includes(response.status) ? await response.text() : (await readCappedText(response, ERROR_BODY_CHARS * 4)).text;
	} catch (error) {
		throw failureOf(error instanceof Error ? error : new Error(String(error)), label, href, timeout, init.signal, timeoutMs);
	}
	if (!response.ok && !(init.accept ?? []).includes(response.status)) {
		const excerpt = bodyExcerpt(text);
		throw new FetchJsonError(`${label} failed (HTTP ${response.status})${excerpt === "" ? "" : `: ${excerpt}`}`, "status", href, response.status, excerpt);
	}
	if (text.trim() === "") return {
		status: response.status,
		headers: response.headers,
		json: void 0
	};
	try {
		return {
			status: response.status,
			headers: response.headers,
			json: JSON.parse(text)
		};
	} catch (error) {
		if (!response.ok) return {
			status: response.status,
			headers: response.headers,
			json: void 0
		};
		throw new FetchJsonError(`${label} answered something that is not JSON (HTTP ${response.status}): ${bodyExcerpt(text)}`, "parse", href, response.status, bodyExcerpt(text), { cause: error });
	}
};
// src/sources/http.ts
var USER_AGENT = "intentic-prawo/1.0 (+https://intentic.dev)";
var JSON_TIMEOUT_MS = 3e4;
var DOCUMENT_TIMEOUT_MS = 12e4;
var createHttp = (call = fetch) => {
	const get = async (url) => {
		const response = await call(url, {
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS)
		});
		if (!response.ok) throw new Error(`GET ${url} failed (HTTP ${String(response.status)})`);
		return response;
	};
	return {
		json: async (url, schema) => schema.parse((await fetchJsonResponse(url, {
			headers: { "user-agent": USER_AGENT },
			timeoutMs: JSON_TIMEOUT_MS,
			fetch: call
		})).json),
		bytes: async (url) => new Uint8Array(await (await get(url)).arrayBuffer()),
		text: async (url) => await (await get(url)).text()
	};
};
// src/main.ts
var IDENTITY = "intentic.prawo";
var POLAND = asZone("Europe/Warsaw") ?? "UTC";
var PDF_TIMEOUT_MS = 18e4;
var pdfText = async (bytes) => {
	const dir = await mkdtemp(join(tmpdir(), "prawo-"));
	try {
		const file = join(dir, "act.pdf");
		await writeFile(file, bytes);
		return (await execBounded("fileq", [
			"read",
			"--plain",
			file
		], {
			timeoutMs: PDF_TIMEOUT_MS,
			maxOutput: 67108864
		})).stdout;
	} finally {
		await rm(dir, {
			recursive: true,
			force: true
		});
	}
};
var defaultLimit = () => {
	const configured = Number(process.env["PRAWO_RESULTS_LIMIT"]);
	return Number.isInteger(configured) && configured >= 1 && configured <= 100 ? configured : 10;
};
process.stdout.on("error", (error) => {
	if (error.code !== "EPIPE") throw error;
});
var http = createHttp();
var argv = process.argv.slice(2);
var output = await execute(argv, new Law({
	eli: new Eli(http),
	saos: new Saos(http),
	cache: new Cache(join(findWorkspaceRoot(process.env, process.cwd()), extensionCacheDir(IDENTITY)), () => /* @__PURE__ */ new Date()),
	pdfText,
	today: () => civilDayIn(Date.now(), POLAND),
	refresh: argv.includes("--refresh")
}), {
	limit: defaultLimit(),
	today: civilDayIn(Date.now(), POLAND)
});
process.stdout.write(`${output.text}\n`);
process.exitCode = output.code;
export {};
