import { Client } from "./client";
import { ClientState, PageRenderer, PageRenderMode } from "./page-renderer";
import { loadModule, ServerModule } from "./server-compiler";
import { defer, escape, escaping } from "./event-loop";
import { exists, readFile } from "./fileUtils";

import { JsonValue, Channel } from "mobius-types";

import * as mobiusModule from "mobius";

import { interceptGlobals, FakedGlobals } from "../common/determinism";
import { logOrdering, roundTrip, eventForValue, eventForException, parseValueEvent, disconnectedError, BootstrapData, Event } from "../common/_internal";

import { createWriteStream } from "fs";
import { fork, ChildProcess } from "child_process";
import { Request } from "express";
import { JSDOM } from "jsdom";

const resolvedPromise: Promise<void> = Promise.resolve();

// Lazy version of loadModule so that the sandbox module is loaded on first use
let loadModuleLazy: typeof loadModule = (path, module, globalProperties, require_) => {
	loadModuleLazy = require("./server-compiler").loadModule as typeof loadModule;
	return loadModuleLazy(path, module, globalProperties, require_);
}

// Hack so that Module._findPath will find TypeScript files
const Module = require("module");
Module._extensions[".ts"] = Module._extensions[".tsx"] = function() {}

interface MobiusGlobalProperties {
	document: Document,
	request?: Request,
}

export interface ArchivedSession {
	events: (Event | boolean)[];
	channels: number[];
}

const enum ArchiveStatus {
	None = 0,
	Partial = 1,
	Full
};

export interface Host {
	allowMultipleClientsPerSession: boolean;
	document: Document;
	secrets: JsonValue;
	serverModulePaths: string[];
	modulePaths: string[];
	scriptPath: string;
	hostname?: string;
	dom: JSDOM;
	noscript: Element;
	metaRedirect: Element;
	sessions: Map<string, MasterSession>;
	pathForSessionId(sessionID: string): string;
}

export interface ClientBootstrap {
	queuedLocalEvents?: Event[];
	clientID: number;
}

export abstract class MasterSession {
	sessionID: string;
	clients = new Map<number, Client>();
	currentClientID: number = 0;
	sharingEnabled: boolean = false;
	lastMessageTime: number = Date.now();
	constructor(sessionID: string) {
		this.sessionID = sessionID;
	}
	abstract destroy() : Promise<void>;
	abstract destroyIfExhausted() : Promise<void>;
	abstract archiveEvents(includeTrailer: boolean) : Promise<void>;
	abstract unarchiveEvents() : Promise<void>;
	abstract processEvents(events: Event[], noJavaScript?: boolean) : Promise<void>;
	abstract receivedRequest(request: Request) : void;
	abstract prerenderContent() : Promise<void>;
	abstract updateOpenServerChannelStatus(newValue: boolean) : void;
	abstract hasLocalChannels() : boolean;
	abstract render(mode: PageRenderMode, client: ClientState & ClientBootstrap, clientURL: string, noScriptURL?: string, bootstrap?: boolean) : Promise<string>;
	abstract valueForFormField(name: string) : Promise<string | undefined>;
	newClient(request: Request) {
		const newClientId = this.currentClientID++;
		if ((newClientId == 0) || this.sharingEnabled) {
			const result = new Client(this, request, newClientId);
			this.clients.set(newClientId, result);
			this.receivedRequest(request);
			return result;
		}
		throw new Error("Multiple clients attached to the same session are not supported!");
	}
	hasCapableClient() {
		for (const client of this.clients) {
			if (client[1].clientIsActive) {
				return true;
			}
		}
		return false;
	}
}

export class InProcessSession extends MasterSession {
	worker: WorkerSession;
	host: Host;
	request?: Request;
	constructor(sessionID: string, host: Host, request?: Request) {
		super(sessionID);
		this.host = host;
		this.request = request;
		this.worker = new WorkerSession(host, this, sessionID, new PageRenderer(host.dom, host.noscript, host.metaRedirect));
	}
	destroy() {
		return this.worker.destroy();
	}
	destroyIfExhausted() : Promise<void> {
		return this.worker.destroyIfExhausted();
	}
	archiveEvents(includeTrailer: boolean) {
		return this.worker.archiveEvents(includeTrailer);
	}
	unarchiveEvents() {
		return this.worker.unarchiveEvents();
	}
	processEvents(events: Event[], noJavaScript?: boolean) {
		return this.worker.processEvents(events, noJavaScript);
	}
	receivedRequest(request: Request) {
		this.request = request;
	}
	prerenderContent() : Promise<void> {
		return this.worker.prerenderContent();
	}
	updateOpenServerChannelStatus(newValue: boolean) {
		this.worker.updateOpenServerChannelStatus(newValue);
	}
	hasLocalChannels() {
		return this.worker.localChannelCount !== 0;
	}
	async render(mode: PageRenderMode, client: ClientState & ClientBootstrap, clientURL: string, noScriptURL?: string, bootstrap?: boolean) : Promise<string> {
		return await this.worker.pageRenderer.render(mode, client, this.worker, clientURL, noScriptURL, bootstrap ? await this.worker.generateBootstrapData(client) : undefined);
	}
	async valueForFormField(name: string) : Promise<string | undefined> {
		const element = this.worker.pageRenderer.body.querySelector("[name=\"" + name + "\"]");
		if (element) {
			switch (element.nodeName) {
				case "INPUT":
				case "TEXTAREA":
					return (element as HTMLInputElement).value;
			}
		}
	}
	// ClientCallbacks
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
		this.host.sessions.delete(this.sessionID);
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
}

export abstract class OutOfProcessSession extends MasterSession {
	process: ChildProcess;
	constructor(sessionID: string, process: ChildProcess) {
		super(sessionID);
		this.process = process;		
	}
}

export function createSessionGroup(host: Host, workerCount: number) {
	if (workerCount <= 0) {
		return (sessionID: string, request?: Request) => new InProcessSession(sessionID, host, request);
	}
	const workers: ChildProcess[] = [];
	for (let i = 0; i < workerCount; i++) {
		workers[i] = fork(require.resolve("./session"));
	}
	// let currentWorker = 0;
	return (sessionID: string, request?: Request) => {
		throw new Error("Not supported yet!");
		// const result = new OutOfProcessSession(sessionID, workers[currentWorker]);
		// if ((++currentWorker) === workerCount) {
		// 	currentWorker = 0;
		// }
		// return result;
	}
}

const bakedModules: { [moduleName: string]: (session: WorkerSession) => any } = {
	mobius: (session: WorkerSession) => session.mobius,
	request: (session: WorkerSession) => session.clients.request,
	setCookie: (session: WorkerSession) => session.clients.setCookie.bind(session.clients),
	document: (session: WorkerSession) => session.globalProperties.document,
	head: (session: WorkerSession) => session.pageRenderer.head,
	body: (session: WorkerSession) => session.pageRenderer.body,
	secrets: (session: WorkerSession) => session.host.secrets,
};

interface ClientCallbacks {
	request?: Request;
	synchronizeChannels() : Promise<void>;
	scheduleSynchronize() : void;
	sendEvent(event: Event) : void;
	setCookie(key: string, value: string) : void;
	sessionWasDestroyed() : Promise<void>;
	hasCapableClient() : boolean;
}

export class WorkerSession {
	host: Host;
	clients: ClientCallbacks;
	sessionID: string;
	dead: boolean = false;
	// Script context
	modules = new Map<string, ServerModule>();
	mobius: typeof mobiusModule;
	hasRun: boolean = false;
	pageRenderer: PageRenderer;
	globalProperties: MobiusGlobalProperties & FakedGlobals;
	Math: typeof Math;
	// Local channels
	localChannelCounter: number = 0;
	localChannels = new Map<number, (event?: Event) => void>();
	localChannelCount: number = 0;
	dispatchingAPIImplementation: number = 0;
	prerenderChannelCount: number = 0;
	prerenderCompleted?: Promise<void>;
	completePrerender?: () => void;
	// Remote channels
	remoteChannelCounter: number = 0;
	pendingChannels = new Map<number, (event?: Event) => void>();
	pendingChannelCount: number = 0;
	dispatchingEvent: number = 0;
	// Incoming Events
	currentEvents: (Event | boolean)[] | undefined;
	hadOpenServerChannel: boolean = false;
	// Archival
	recentEvents?: (Event | boolean)[];
	archivingEvents?: Promise<void>;
	archiveStatus: ArchiveStatus = ArchiveStatus.None;
	bootstrappingChannels?: Set<number>;
	bootstrappingPromise?: Promise<void>;
	// Session sharing
	sharingEnabled?: true;
	constructor(host: Host, clients: ClientCallbacks, sessionID: string, pageRenderer: PageRenderer) {
		this.host = host;
		this.clients = clients;
		this.sessionID = sessionID;
		this.pageRenderer = pageRenderer;
		// Server-side version of the API
		this.mobius = {
			disconnect: () => this.destroy().catch(escape),
			dead: false,
			createClientPromise: this.createClientPromise,
			createServerPromise: this.createServerPromise,
			createClientChannel: this.createClientChannel,
			createServerChannel: this.createServerChannel,
			coordinateValue: this.coordinateValue,
			synchronize: () => this.createServerPromise(() => undefined),
			flush: async () => {
				if (this.dead) {
					throw disconnectedError();
				}
				this.clients.scheduleSynchronize();
				return resolvedPromise;
			},
			shareSession: this.shareSession
		};
		const globalProperties: MobiusGlobalProperties & Partial<FakedGlobals> = {
			document: this.host.document,
			request: this.clients.request
		};
		this.globalProperties = interceptGlobals(globalProperties, () => this.insideCallback, this.coordinateValue, this.createServerChannel);
		if (this.host.allowMultipleClientsPerSession) {
			this.recentEvents = [];
		}
	}

	loadModule(path: string, newModule: ServerModule, allowNodeModules: boolean) {
		loadModuleLazy(path, newModule, this.globalProperties, (name: string) => {
			const bakedModule = bakedModules[name];
			if (bakedModule) {
				return bakedModule(this);
			}
			const modulePath = Module._findPath(name, newModule.paths, false);
			if (modulePath) {
				const existingModule = this.modules.get(modulePath);
				if (existingModule) {
					return existingModule.exports;
				}
				const subModule: ServerModule = {
					exports: {},
					paths: newModule.paths
				};
				this.modules.set(modulePath, subModule);
				this.loadModule(modulePath, subModule, !!Module._findPath(name, this.host.serverModulePaths));
				return subModule.exports;
			}
			const result = require(name);
			if (!allowNodeModules) {
				var e = new Error(`Cannot access module '${name}' in this context`);
				(e as any).code = "MODULE_NOT_FOUND";
				throw e;
			}
			return result;
		});
		return newModule;
	}

	// Async so that errors inside user code startup will log to console as unhandled promise rejection, but app will proceed
	async run() {
		if (!this.hasRun) {
			this.hasRun = true;
			this.enteringCallback();
			this.loadModule(this.host.scriptPath, {
				exports: {},
				paths: this.host.modulePaths
			}, false);
		}
	}

	sendEvent(event: Event) {
		if (this.recentEvents) {
			this.recentEvents.push(event);
		}
		this.clients.sendEvent(event);
	}

	dispatchClientEvent(event: Event) {
		let channelId = event[0];
		if (channelId < 0) {
			// Server decided the ordering on "fenced" events
			this.sendEvent(event);
			channelId = -channelId;
		} else {
			// Record the event ordering, but don't send to client as they've already processed it
			event[0] = -channelId;
			if (this.recentEvents) {
				this.recentEvents.push(event);
			}
		}
		const channel = this.pendingChannels.get(channelId);
		if (channel) {
			logOrdering("client", "message", channelId, this.sessionID);
			channel(event.slice() as Event);
		} else {
			// Client-side event source was destroyed on the server between the time it generated an event and the time the server received it
			// This event will be silently dropped--dispatching would cause split brain!
		}
	}

	updateOpenServerChannelStatus(newValue: boolean) {
		if (this.hadOpenServerChannel != newValue) {
			this.hadOpenServerChannel = newValue;
			if (this.recentEvents) {
				this.recentEvents.push(newValue);
			}
		}
	}

	async processEvents(events: Event[], noJavaScript?: boolean) : Promise<void> {
		// Read each event and dispatch the appropriate event in order
		this.updateOpenServerChannelStatus(noJavaScript ? true : (this.localChannelCount != 0));
		this.currentEvents = events;
		this.run();
		for (let event of events) {
			this.dispatchClientEvent(event);
			await defer();
		}
		this.updateOpenServerChannelStatus(this.localChannelCount != 0);
		this.currentEvents = undefined;
	}

	enterLocalChannel(delayPrerender: boolean = true) : number {
		if (delayPrerender) {
			++this.prerenderChannelCount;
		}
		return ++this.localChannelCount;
	}
	exitLocalChannel(resumePrerender: boolean = true) : number {
		if (resumePrerender) {
			if (--this.prerenderChannelCount == 0) {
				defer().then(() => {
					if (this.completePrerender) {
						this.completePrerender();
						delete this.completePrerender;
						delete this.prerenderCompleted;
					}
				});
			}
		}
		return --this.localChannelCount;
	}
	prerenderContent() : Promise<void> {
		if (this.prerenderCompleted) {
			return this.prerenderCompleted;
		}
		this.enterLocalChannel();
		this.run();
		defer().then(() => this.exitLocalChannel());
		return this.prerenderCompleted = new Promise<void>(resolve => {
			this.completePrerender = resolve;
		});
	}
	shouldImplementLocalChannel(channelId: number) : boolean {
		return !this.bootstrappingChannels || this.bootstrappingChannels.has(channelId);
	}

	get insideCallback() {
		return this.dispatchingEvent != 0 && this.dispatchingAPIImplementation == 0;
	}
	async enteringCallback() {
		this.dispatchingEvent++;
		await defer();
		this.dispatchingEvent--;
	}
	createServerPromise = <T extends JsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender: boolean = true) => {
		if (!this.insideCallback) {
			return new Promise<T>(resolve => resolve(ask()));
		}
		// Record and ship values/errors of server-side promises
		let channelId = ++this.localChannelCounter;
		const exit = escaping(() => {
			if (channelId != -1) {
				this.localChannels.delete(channelId);
				channelId = -1;
				this.exitLocalChannel(includedInPrerender);
			}
		});
		return new Promise<T>((resolve, reject) => {
			logOrdering("server", "open", channelId, this.sessionID);
			this.enterLocalChannel(includedInPrerender);
			this.localChannels.set(channelId, (event?: Event) => {
				if (channelId >= 0) {
					if (event) {
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						resolvedPromise.then(exit);
						this.enteringCallback();
						parseValueEvent(global, event, resolve as (value: JsonValue) => void, reject);
					} else {
						logOrdering("server", "close", channelId, this.sessionID);
						exit();
					}
				}
			});
			if (!this.shouldImplementLocalChannel(channelId)) {
				return;
			}
			this.dispatchingAPIImplementation++;
			let result = new Promise<T>(resolve => resolve(ask()));
			this.dispatchingAPIImplementation--;
			result.then(async value => {
				const event = eventForValue(channelId, value);
				if (this.currentEvents) {
					if (this.bootstrappingPromise) {
						await this.bootstrappingPromise;
					}
					await defer();
				}
				if (channelId >= 0) {
					try {
						this.updateOpenServerChannelStatus(true);
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						this.sendEvent(event);
					} catch (e) {
						escape(e);
					}
					resolvedPromise.then(exit);
					const roundtripped = roundTrip(value);
					this.enteringCallback();
					resolve(roundtripped);
				}
			}).catch(async error => {
				if (this.currentEvents) {
					if (this.bootstrappingPromise) {
						await this.bootstrappingPromise;
					}
					await defer();
				}
				if (channelId >= 0) {
					try {
						this.updateOpenServerChannelStatus(true);
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						this.sendEvent(eventForException(channelId, error));
					} catch (e) {
						escape(e);
					}
					resolvedPromise.then(exit);
					this.enteringCallback();
					reject(error);
				}
			});
		});
	}
	createServerChannel = <T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender: boolean = true) => {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		let state: U | undefined;
		if (!this.insideCallback) {
			// Not coordinating
			let open = true;
			try {
				const potentialState = onOpen(function() {
					if (open) {
						callback.apply(null, arguments);
					}
				} as any as T);
				if (onClose) {
					state = potentialState;
				}
			} catch (e) {
				onClose = undefined;
				escape(e);
			}
			return {
				channelId: -1,
				close() {
					if (open) {
						open = false;
						if (onClose) {
							session.dispatchingAPIImplementation++;
							escaping(onClose)(state as U);
							session.dispatchingAPIImplementation--;
						}
					}
				}
			};
		}
		// Record and ship arguments of server-side events
		const session = this;
		let channelId = ++session.localChannelCounter;
		logOrdering("server", "open", channelId, this.sessionID);
		session.enterLocalChannel(includedInPrerender);
		const close = () => {
			if (channelId >= 0) {
				logOrdering("server", "close", channelId, session.sessionID);
				session.localChannels.delete(channelId);
				channelId = -1;
				resolvedPromise.then(escaping(() => {
					if (session.exitLocalChannel(includedInPrerender) == 0) {
						// If this was the last server channel, reevaluate queued events so the session can be potentially collected
						session.clients.scheduleSynchronize();
					}
				}));
				if (onClose) {
					session.dispatchingAPIImplementation++;
					escaping(onClose)(state as U);
					session.dispatchingAPIImplementation--;
				}
			}
		};
		session.localChannels.set(channelId, (event?: Event) => {
			if (event) {
				logOrdering("server", "message", channelId, this.sessionID);
				session.enteringCallback();
				(callback as any as Function).apply(null, roundTrip(event.slice(1)));
			} else {
				close();
			}
		});
		if (this.shouldImplementLocalChannel(channelId)) {
			try {
				this.dispatchingAPIImplementation++;
				const potentialState = onOpen(function() {
					if (channelId >= 0) {
						let args = roundTrip([...arguments]);
						(async () => {
							if (session.currentEvents) {
								if (session.bootstrappingPromise) {
									await session.bootstrappingPromise;
								}
								await defer();
							}
							try {
								session.updateOpenServerChannelStatus(true);
								session.sendEvent([channelId, ...roundTrip(args)] as Event);
							} catch (e) {
								escape(e);
							}
							logOrdering("server", "message", channelId, session.sessionID);
							session.enteringCallback();
							(callback as any as Function).apply(null, args);
						})();
					}
				} as any as T);
				if (onClose) {
					state = potentialState;
				}
				this.dispatchingAPIImplementation--;
			} catch (e) {
				this.dispatchingAPIImplementation--;
				onClose = undefined;
				escape(e);
			}
		} else {
			onClose = undefined;
		}
		return {
			channelId,
			close
		};
	}

	createRawClientChannel(callback: (event: Event | undefined) => void) : Channel {
		const session = this;
		session.pendingChannelCount++;
		let channelId = ++session.remoteChannelCounter;
		logOrdering("client", "open", channelId, this.sessionID);
		this.pendingChannels.set(channelId, callback);
		return {
			channelId,
			close() {
				if (channelId != -1) {
					logOrdering("client", "close", channelId, session.sessionID);
					session.pendingChannels.delete(channelId);
					channelId = -1;
					if ((--session.pendingChannelCount) == 0) {
						// If this was the last client channel, reevaluate queued events so the session can be potentially collected
						session.clients.scheduleSynchronize();
					}
				}
			}
		};
	}
	createClientPromise = <T extends JsonValue | void>(fallback?: () => Promise<T> | T) => {
		return new Promise<T>((resolve, reject) => {
			if (!this.insideCallback) {
				return reject(new Error("Unable to create client promise in this context!"));
			}
			if (this.dead) {
				if (fallback) {
					return resolve(fallback());
				}
				return reject(disconnectedError());
			}
			const channel = this.createRawClientChannel(event => {
				this.enteringCallback();
				channel.close();
				if (event) {
					parseValueEvent(global, event, resolve as (value: JsonValue | void) => void, reject);
				} else {
					reject(disconnectedError());
				}
			});
			if (!this.clients.hasCapableClient() && !this.bootstrappingPromise) {
				this.enterLocalChannel(true);
				this.dispatchingAPIImplementation++;
				const promise = fallback ? new Promise<T>(resolve => resolve(fallback())) : Promise.reject(new Error("Browser does not support client-side rendering!"))
				this.dispatchingAPIImplementation--;
				promise.then(async value => {
					if (this.currentEvents) {
						await defer();
					}
					this.dispatchClientEvent(eventForValue(-channel.channelId, value));
				}).catch(async error => {
					if (this.currentEvents) {
						await defer();
					}
					this.dispatchClientEvent(eventForException(-channel.channelId, error));
				}).then(() => this.exitLocalChannel());
			}
		});
	}
	createClientChannel = <T extends Function>(callback: T) => {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		if (!this.insideCallback) {
			throw new Error("Unable to create client channel in this context!");
		}
		const channel = this.createRawClientChannel(event => {
			if (event) {
				event.shift();
				this.enteringCallback();
				resolvedPromise.then(() => callback.apply(null, event));
			} else {
				channel.close();
			}
		});
		return channel;
	}

	findValueEvent(channelId: number) : Event | undefined {
		let events = this.currentEvents;
		if (events) {
			// Events are represented differently inside currentEvents depending on whether we're processing a client message or unarchiving
			// Makes more sense to handle the special case here than to transform the array just for this one case
			if (!this.bootstrappingChannels) {
				if (channelId >= 0) {
					return;
				}
				channelId = -channelId;
			}
			for (let event of events as Event[]) {
				if (event[0] == channelId) {
					return event;
				}
			}
		}
	}

	coordinateValue = <T extends JsonValue>(generator: () => T) => {
		if (!this.insideCallback) {
			return generator();
		}
		let value: T;
		if (!this.hadOpenServerChannel) {
			let channelId = ++this.remoteChannelCounter;
			logOrdering("client", "open", channelId, this.sessionID);
			// Peek at incoming events to find the value generated on the client
			const event = this.findValueEvent(-channelId);
			if (event) {
				logOrdering("client", "message", channelId, this.sessionID);
				logOrdering("client", "close", channelId, this.sessionID);
				return parseValueEvent(global, event, value => value, error => {
					throw error;
				}) as T;
			}
			console.log("Expected a value from the client, but didn't receive one which may result in split-brain!\nCall stack is " + (new Error() as any).stack.split(/\n\s*/g).slice(2).join("\n\t"));
			value = generator();
			logOrdering("client", "message", channelId, this.sessionID);
			logOrdering("client", "close", channelId, this.sessionID);
		} else {
			let channelId = ++this.localChannelCounter;
			logOrdering("server", "open", channelId, this.sessionID);
			const event = this.findValueEvent(channelId);
			if (event) {
				logOrdering("server", "message", channelId, this.sessionID);
				logOrdering("server", "close", channelId, this.sessionID);
				this.sendEvent(event);
				return parseValueEvent(global, event, value => value, error => {
					throw error;
				}) as T;
			}
			try {
				value = generator();
				const event = eventForValue(channelId, value);
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendEvent(event);
				} catch(e) {
					escape(e);
				}
			} catch(e) {
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendEvent(eventForException(channelId, e));
				} catch(e) {
					escape(e);
				}
				throw e;
			}
		}
		return roundTrip(value) as T;
	}

	shareSession = async () => {
		// Server promise so that client can confirm that sharing is enabled
		const server = this.createServerPromise(async () => {
			if (!this.host.allowMultipleClientsPerSession) {
				throw new Error("Sharing has been disabled!");
			}
			this.sharingEnabled = true;
			const request = this.clients.request;
			if (request) {
				return `${request.protocol}://${this.host.hostname || request.get("host")}${request.url.replace(/(\.websocket)?\?.*$/, "")}?sessionID=${this.sessionID}`;
			}
			throw new Error("Session does not have a request to load sharing URL from!");
		});
		const result = await server;
		// Dummy channel that stays open
		this.createServerChannel(emptyFunction, emptyFunction, undefined, false);
		return result;
	}

	async destroy() {
		if (!this.dead) {
			this.dead = true;
			this.mobius.dead = true;
			await this.archiveEvents(true);
			// await unlink(this.host.pathForSessionId(this.sessionID));
			for (const pair of this.pendingChannels) {
				pair[1]();
			}
			this.pendingChannels.clear();
			for (const pair of this.localChannels) {
				pair[1]();
			}
			this.localChannels.clear();
			await this.clients.sessionWasDestroyed();
		}
	}

	async destroyIfExhausted() {
		// If no channels remain, the session is in a state where no more events
		// can be sent from either the client or server. Session can be destroyed
		if (this.pendingChannelCount + this.localChannelCount == 0) {
			await this.destroy();
		}
	}

	async archiveEvents(includeTrailer: boolean) : Promise<void> {
		// Can only archive if we're recording events
		if (!this.recentEvents || (!this.recentEvents.length && !includeTrailer)) {
			return;
		}
		// Only one archiver can run at a time
		while (this.archivingEvents) {
			await this.archivingEvents;
		}
		const recentEvents = this.recentEvents;
		if (recentEvents) {
			this.recentEvents = [];
		}
		// Actually archive
		await (this.archivingEvents = (async () => {
			const path = this.host.pathForSessionId(this.sessionID);
			// Determine where to write and whether or not this is a fresh session
			const freshFile = this.archiveStatus != ArchiveStatus.Partial || !(await exists(path));
			// Prepare events
			let unarchivedEvents: (Event | boolean)[] | undefined;
			if (this.archiveStatus == ArchiveStatus.Full) {
				try {
					unarchivedEvents = (await WorkerSession.readArchivedSession(this.host.pathForSessionId(this.sessionID))).events;
				} catch (e) {
				}
			}
			const events = unarchivedEvents ? unarchivedEvents.concat(recentEvents || []) : (recentEvents || []);
			const serializedEvents = JSON.stringify(events);
			// Attempt to write as stream
			const stream = createWriteStream(path, { flags: freshFile ? "w" : "a" });
			if (freshFile) {
				stream.write("{\"events\":");
				stream.write(serializedEvents.substring(0, serializedEvents.length - 1));
			} else if (events.length) {
				stream.write(",");
				stream.write(serializedEvents.substring(1, serializedEvents.length - 1));
			}
			// Include full trailer if required
			if (includeTrailer) {
				stream.write("],\"channels\":" + JSON.stringify(Array.from(this.localChannels.keys())) + "}");
			}
			stream.end();
			return stream;
		})().then(stream => new Promise<void>(resolve => {
			const finished = () => {
				this.archiveStatus = includeTrailer ? ArchiveStatus.Full : ArchiveStatus.Partial;
				delete this.archivingEvents;
				resolve();
			};
			stream.on("finish", finished);
			stream.on("error", () => {
				// Failed to write, put the events back
				this.recentEvents = recentEvents.concat(this.recentEvents || []);
				finished();
			});
		})));
	}

	static async readArchivedSession(path: string) : Promise<Partial<ArchivedSession>> {
		const rawContents = (await readFile(path)).toString();
		const validJSONContents = rawContents[rawContents.length - 1] == "}" ? rawContents : rawContents + "]}";
		return JSON.parse(validJSONContents) as Partial<ArchivedSession>;
	}

	async readAllEvents() : Promise<(Event | boolean)[] | undefined> {
		if (this.archiveStatus == ArchiveStatus.None) {
			return this.recentEvents;
		}
		let archivedEvents: (Event | boolean)[] | undefined;
		do {
			if (this.archivingEvents) {
				await this.archivingEvents;
			}
			archivedEvents = (await WorkerSession.readArchivedSession(this.host.pathForSessionId(this.sessionID))).events;
		} while (this.archivingEvents);
		const recentEvents = this.recentEvents;
		if (!recentEvents) {
			return undefined;
		}
		return archivedEvents ? archivedEvents.concat(recentEvents) : recentEvents;
	}


	async unarchiveEvents() : Promise<void> {
		const path = this.host.pathForSessionId(this.sessionID);
		const archive = await WorkerSession.readArchivedSession(path);
		this.bootstrappingChannels = new Set<number>(archive.channels);
		let completedBootstrapping: () => void;
		this.bootstrappingPromise = new Promise<void>(resolve => completedBootstrapping = resolve);
		// Read each event and dispatch the appropriate event in order
		const events = archive.events!;
		this.currentEvents = events;
		const firstEvent = events[0];
		if (typeof firstEvent == "boolean") {
			this.updateOpenServerChannelStatus(firstEvent);
		}
		this.run();
		for (let event of events) {
			if (typeof event == "boolean") {
				this.updateOpenServerChannelStatus(event);
				continue;
			}
			const channelId = event[0];
			if (channelId < 0) {
				this.dispatchClientEvent(event);
			} else {
				if (this.recentEvents) {
					this.recentEvents.push(event);
				}
				const callback = this.localChannels.get(channelId);
				if (callback) {
					logOrdering("server", "message", channelId, this.sessionID);
					callback(event);
				}
			}
			await defer();
		}
		this.currentEvents = undefined;
		this.recentEvents = archive.events;
		this.bootstrappingChannels = undefined;
		this.bootstrappingPromise = undefined;
		completedBootstrapping!();
	}

	async generateBootstrapData(client: ClientBootstrap) : Promise<BootstrapData> {
		const queuedLocalEvents = await this.readAllEvents() || client.queuedLocalEvents;
		const result: BootstrapData = { sessionID: this.sessionID, channels: Array.from(this.pendingChannels.keys()) };
		if (queuedLocalEvents) {
			// TODO: Do this in such a way that we aren't mutating client directly
			client.queuedLocalEvents = undefined;
			result.events = queuedLocalEvents;
		}
		if (client.clientID) {
			result.clientID = client.clientID;
		}
		return result;
	}
};

function emptyFunction() {
}
