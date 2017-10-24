import { Client } from "./client";
import { ClientState, PageRenderMode } from "./page-renderer";
import { ClientBootstrap, HostSandbox, HostSandboxOptions, LocalSessionSandbox, SessionSandbox, SessionSandboxClient } from "./session-sandbox";
import { escape } from "./event-loop";
import { peek, Redacted } from "../server/redact";

import { eventForException, eventForValue, roundTrip, parseValueEvent, Event } from "../common/_internal";
import { JsonValue, JsonArray, JsonMap } from "mobius-types";

import { fork, ChildProcess } from "child_process";
import { Request } from "express";

function generateBaseURL(options: HostSandboxOptions, request?: Request) {
	if (request) {
		return request.protocol + "://" + (options.hostname || request.get("host")) + request.url.replace(/(\.websocket)?\?.*$/, "");
	}
	throw new Error("Session does not have a request to load URL from!");
}

export interface Session extends SessionSandbox {
	lastMessageTime: number;
	client: SessionClients;
}

export interface SessionClients extends SessionSandboxClient {
	clients: Map<number, Client>;
	newClient(session: Session, request: Request) : Client;
	get(clientID: number) : Client | undefined;
}

class InProcessClients implements SessionClients {
	sessionID: string;
	sessions: Map<string, Session>;
	request?: Request;
	clients = new Map<number, Client>();
	currentClientID: number = 0;
	sharingEnabled: boolean = false;
	lastMessageTime: number = Date.now();
	constructor(sessionID: string, sessions: Map<string, Session>, request?: Request) {
		this.sessionID = sessionID;
		this.sessions = sessions;
		this.request = request;
	}
	async synchronizeChannels() : Promise<void> {
		const promises : Promise<void>[] = [];
		for (let client of this.clients.values()) {
			promises.push(client.synchronizeChannels());
		}
		await Promise.all(promises);
	}
	scheduleSynchronize() {
		for (const client of this.clients.values()) {
			client.scheduleSynchronize();
		}
	}
	async sessionWasDestroyed() {
		const promises : Promise<void>[] = [];
		for (const client of this.clients.values()) {
			promises.push(client.destroy());
		}
		await Promise.all(promises);
		this.sessions.delete(this.sessionID);
	}
	sendEvent(event: Event) {
		for (const client of this.clients.values()) {
			client.sendEvent(event);
		}
	}
	setCookie(key: string, value: string) {
		for (const client of this.clients.values()) {
			client.setCookie(key, value);
		}
	}
	cookieHeader() {
		if (this.request) {
			const cookieHeader = this.request.headers["cookie"];
			if (cookieHeader) {
				return cookieHeader.toString();
			}
		}
		return "";
	}
	getBaseURL(options: HostSandboxOptions) {
		return generateBaseURL(options, this.request);
	}
	newClient(session: Session, request: Request) {
		const newClientId = this.currentClientID++;
		if ((newClientId == 0) || this.sharingEnabled) {
			const result = new Client(session, request, newClientId);
			this.clients.set(newClientId, result);
			return result;
		}
		throw new Error("Multiple clients attached to the same session are not supported!");
	}
	get(clientID: number) : Client | undefined {
		return this.clients.get(clientID);
	}
}

class InProcessSession extends LocalSessionSandbox<InProcessClients> implements Session {
	lastMessageTime: number = Date.now();
}


let toWorkerMessageId = 0;
let toHostMessageId = 0;
const workerResolves = new Map<number, [(value: any) => void, (value: any) => void]>();

type CommandMessage = [string, string, number];

class WorkerSandboxClient implements SessionSandboxClient {
	sessionID: string;
	constructor(sessionID: string) {
		this.sessionID = sessionID;
	}
	send<T = void>(method: string, args?: any[]) : Promise<T> {
		const responseId = toHostMessageId = (toHostMessageId + 1) | 0;
		const prefix: CommandMessage = [this.sessionID, method, responseId];
		process.send!(args && args.length ? prefix.concat(args) : prefix);
		return new Promise<T>((resolve, reject) => {
			workerResolves.set(responseId, [resolve, reject]);
		});
	}
	synchronizeChannels() : Promise<void> {
		return this.send("synchronizeChannels");
	}
	scheduleSynchronize() {
		return this.send("scheduleSynchronize");
	}
	sessionWasDestroyed() {
		return this.send("sessionWasDestroyed");
	}
	sendEvent(event: Event) {
		return this.send("sendEvent", [event]);
	}
	setCookie(key: string, value: string) {
		return this.send("setCookie", [key, value]);
	}
	cookieHeader() {
		return this.send<string>("cookieHeader");
	}
	getBaseURL(options: HostSandboxOptions) {
		return this.send<string>("getBaseURL", [options]);
	}
}

class OutOfProcessSession implements Session {
	sessionID: string;
	process: ChildProcess;
	client: InProcessClients;
	lastMessageTime: number = Date.now();
	constructor(client: InProcessClients, sessionID: string, process: ChildProcess) {
		this.client = client;
		this.sessionID = sessionID;
		this.process = process;
	}
	send<T = void>(method: string, args?: any[]) : Promise<T> {
		const responseId = toWorkerMessageId = (toWorkerMessageId + 1) | 0;
		const prefix: CommandMessage = [this.sessionID, method, responseId];
		this.process.send(args && args.length ? prefix.concat(args) : prefix);
		return new Promise<T>((resolve, reject) => {
			workerResolves.set(responseId, [resolve, reject]);
		});
	}
	destroy() : Promise<void> {
		return this.send("destroy");
	}
	destroyIfExhausted() : Promise<void> {
		return this.send("destroyIfExhausted");
	}
	archiveEvents(includeTrailer: boolean) : Promise<void> {
		return this.send("archiveEvents", [includeTrailer]);
	}
	unarchiveEvents() {
		return this.send("unarchiveEvents");
	}
	processEvents(events: Event[], noJavaScript?: boolean) {
		return this.send("processEvents", [events, noJavaScript]);
	}
	prerenderContent() {
		return this.send("prerenderContent");
	}
	updateOpenServerChannelStatus(newValue: boolean) {
		return this.send("updateOpenServerChannelStatus", [newValue]);
	}
	hasLocalChannels() {
		return this.send<boolean>("hasLocalChannels");
	}
	render(mode: PageRenderMode, client: ClientState & ClientBootstrap, clientURL: string, clientIntegrity: string, fallbackIntegrity: string, noScriptURL?: string, bootstrap?: boolean) : Promise<string> {
		return this.send<string>("render", [mode, client, clientURL, clientIntegrity, fallbackIntegrity, noScriptURL, bootstrap]);
	}
	valueForFormField(name: string) : Promise<string | undefined> {
		return this.send<string | undefined>("valueForFormField", [name]);
	}
	becameActive() {
		return this.send("becameActive");
	}
}

type BroadcastMessage = [false, string, JsonValue];

function isCommandMessage(message: CommandMessage | Event | BroadcastMessage) : message is CommandMessage {
	return typeof message[0] === "string";
}

function isEvent(message: CommandMessage | Event | BroadcastMessage) : message is Event {
	return typeof message[0] === "number";
}

function constructBroadcastModule() {
	const topics = new Map<string, Set<(message: JsonValue) => void>>();
	return {
		send(topic: string | Redacted<string>, message: JsonValue | Redacted<JsonValue | JsonArray | JsonMap>) {
			const observers = topics.get(peek(topic));
			if (observers) {
				const peekedMessage = peek(message);
				for (let observer of observers.values()) {
					try {
						observer(roundTrip(peekedMessage));
					} catch (e) {
						escape(e);
					}
				}
			}
		},
		addListener(topic: string, callback: (message: JsonValue) => void) : void {
			const topicName = peek(topic);
			let observers = topics.get(topicName);
			if (!observers) {
				topics.set(topicName, observers = new Set<(message: JsonValue) => void>());
			}
			observers.add(callback);
		},
		removeListener(topic: string, callback: (message: JsonValue) => void) : void {
			const topicName = peek(topic);
			const observers = topics.get(topicName);
			if (observers && observers.delete(callback) && observers.size === 0) {
				topics.delete(topicName);
			}
		}
	};
}

if (require.main === module) {
	process.addListener("message", function bootstrap(options: HostSandboxOptions) {
		const basicBroadcast = constructBroadcastModule();
		const host = new HostSandbox(options, {
			send(topic: string | Redacted<string>, message: JsonValue | Redacted<JsonValue | JsonArray | JsonMap>) {
				const topicName = peek(topic);
				const peekedMessage = peek(message);
				const broadcastMessage: BroadcastMessage = [false, topicName, peekedMessage];
				process.send!(broadcastMessage);
				basicBroadcast.send(topicName, peekedMessage);
			},
			addListener: basicBroadcast.addListener,
			removeListener: basicBroadcast.removeListener
		});
		const sessions = new Map<string, LocalSessionSandbox<WorkerSandboxClient>>();
		process.removeListener("message", bootstrap);
		process.addListener("message", async (message: CommandMessage | Event | BroadcastMessage) => {
			if (isCommandMessage(message)) {
				// Dispatch commands from master
				const sessionID = message[0];
				let session: any = sessions.get(sessionID);
				if (!session) {
					sessions.set(sessionID, session = new LocalSessionSandbox<WorkerSandboxClient>(host, new WorkerSandboxClient(sessionID), sessionID));
				}
				try {
					const result = await (session as { [method: string] : () => Promise<any> })[message[1]].apply(session, message.slice(3));
					process.send!(eventForValue(message[2], result));
				} catch (e) {
					process.send!(eventForException(message[2], e));
				}
			} else if (isEvent(message)) {
				// Handle promise response
				const resolve = workerResolves.get(message[0]);
				if (resolve) {
					workerResolves.delete(message[0]);
					parseValueEvent(global, message, resolve[0], resolve[1]);
				}
			} else {
				// Receive broadcast from another worker
				basicBroadcast.send(message[1], message[2]);
			}
		});
	});
}

export function createSessionGroup(options: HostSandboxOptions, sessions: Map<string, Session>, workerCount: number) {
	if (workerCount <= 0) {
		const host = new HostSandbox(options, constructBroadcastModule());
		return (sessionID: string, request?: Request) => new InProcessSession(host, new InProcessClients(sessionID, sessions, request), sessionID);
	}
	const workers: ChildProcess[] = [];
	for (let i = 0; i < workerCount; i++) {
		const worker = workers[i] = fork(require.resolve("./session"), [], {
			env: process.env,
			cwd: process.cwd(),
			execArgv: process.execArgv.map(option => {
				const debugOption = option.match(/^(--inspect|--inspect-(brk|port)|--debug|--debug-(brk|port))(=\d+)?$/);
				if (!debugOption) {
					return option;
				}
				return debugOption[1] + "=" + (((process as any).debugPort as number) + i + 1);
			}),
			stdio: [0, 1, 2, "ipc"]
		});
		worker.send(options);
		worker.addListener("message", async (message: CommandMessage | Event | BroadcastMessage) => {
			if (isCommandMessage(message)) {
				// Dispatch commands from worker
				const sessionID = message[0];
				const session = sessions.get(sessionID);
				if (session) {
					const client: any = session.client;
					try {
						const result = await ((client as { [method: string] : () => Promise<any> })[message[1]].apply(client, message.slice(3)));
						worker.send(eventForValue(message[2], result));
					} catch (e) {
						worker.send(eventForException(message[2], e));
					}
				} else {
					worker.send([message[2]]);
				}
			} else if (isEvent(message)) {
				// Handle promise responses
				const resolve = workerResolves.get(message[0]);
				if (resolve) {
					workerResolves.delete(message[0]);
					parseValueEvent(global, message, resolve[0], resolve[1]);
				}
			} else {
				// Forward broadcast message to other workers
				for (let otherWorker of workers) {
					if (otherWorker !== worker) {
						otherWorker.send(message);
					}
				}
			}
		});
	}
	let currentWorker = 0;
	return (sessionID: string, request?: Request) => {
		const result = new OutOfProcessSession(new InProcessClients(sessionID, sessions, request), sessionID, workers[currentWorker]);
		if ((++currentWorker) === workerCount) {
			currentWorker = 0;
		}
		return result;
	}
}
