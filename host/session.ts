import { Client } from "./client";
import { Host } from "./host";
import { ClientState, PageRenderer, PageRenderMode } from "./page-renderer";
import { ClientBootstrap, SessionSandbox } from "./session-sandbox";

import { Event } from "../common/_internal";

import { fork, ChildProcess } from "child_process";
import { Request } from "express";

export abstract class Session {
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

export class InProcessSession extends Session {
	sandbox: SessionSandbox;
	host: Host;
	request?: Request;
	constructor(sessionID: string, host: Host, request?: Request) {
		super(sessionID);
		this.host = host;
		this.request = request;
		this.sandbox = new SessionSandbox(host, this, sessionID, new PageRenderer(host.dom, host.noscript, host.metaRedirect));
	}
	destroy() {
		return this.sandbox.destroy();
	}
	destroyIfExhausted() : Promise<void> {
		return this.sandbox.destroyIfExhausted();
	}
	archiveEvents(includeTrailer: boolean) {
		return this.sandbox.archiveEvents(includeTrailer);
	}
	unarchiveEvents() {
		return this.sandbox.unarchiveEvents();
	}
	processEvents(events: Event[], noJavaScript?: boolean) {
		return this.sandbox.processEvents(events, noJavaScript);
	}
	receivedRequest(request: Request) {
		this.request = request;
	}
	prerenderContent() : Promise<void> {
		return this.sandbox.prerenderContent();
	}
	updateOpenServerChannelStatus(newValue: boolean) {
		this.sandbox.updateOpenServerChannelStatus(newValue);
	}
	hasLocalChannels() {
		return this.sandbox.localChannelCount !== 0;
	}
	async render(mode: PageRenderMode, client: ClientState & ClientBootstrap, clientURL: string, noScriptURL?: string, bootstrap?: boolean) : Promise<string> {
		return await this.sandbox.pageRenderer.render(mode, client, this.sandbox, clientURL, noScriptURL, bootstrap ? await this.sandbox.generateBootstrapData(client) : undefined);
	}
	async valueForFormField(name: string) : Promise<string | undefined> {
		const element = this.sandbox.pageRenderer.body.querySelector("[name=\"" + name + "\"]");
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
	async getBaseURL() {
		const request = this.request;
		if (request) {
			return request.protocol + "://" + (this.host.hostname || request.get("host")) + request.url.replace(/(\.websocket)?\?.*$/, "");
		}
		throw new Error("Session does not have a request to load URL from!");
	}
}

export abstract class OutOfProcessSession extends Session {
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
