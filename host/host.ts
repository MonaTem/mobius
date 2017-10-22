import { ArchivedSession, Session } from "./session";
import { escape } from "./event-loop";
import { exists } from "./fileUtils";

import { ClientMessage } from "../common/_internal";

import { JsonValue } from "mobius-types";

import { JSDOM } from "jsdom";
import patchJSDOM from "./jsdom-patch";

import { Request } from "express";

import * as path from "path";

import * as uuid from "uuid/v4";


export class Host {
	sessions = new Map<string, Session>();
	destroying: boolean = false;
	scriptPath: string;
	hostname?: string;
	serverModulePaths: string[];
	modulePaths: string[];
	internalModulePath: string;
	htmlSource: string;
	dom: JSDOM;
	document: Document;
	noscript: Element;
	metaRedirect: Element;
	staleSessionTimeout: any;
	secrets: JsonValue;
	allowMultipleClientsPerSession: boolean;
	sessionsPath: string;
	constructor(scriptPath: string, serverModulePaths: string[], modulePaths: string[], sessionsPath: string, htmlSource: string, secrets: JsonValue, allowMultipleClientsPerSession: boolean, hostname?: string) {
		this.destroying = false;
		this.allowMultipleClientsPerSession = allowMultipleClientsPerSession;
		this.secrets = secrets;
		this.sessionsPath = sessionsPath;
		this.htmlSource = htmlSource;
		this.dom = new (require("jsdom").JSDOM)(htmlSource) as JSDOM;
		this.document = (this.dom.window as Window).document as Document;
		this.noscript = this.document.createElement("noscript");
		this.metaRedirect = this.document.createElement("meta");
		this.metaRedirect.setAttribute("http-equiv", "refresh");
		this.noscript.appendChild(this.metaRedirect);
		this.scriptPath = scriptPath;
		this.serverModulePaths = serverModulePaths;
		this.modulePaths = modulePaths;
		this.hostname = hostname;
		// Client-side emulation
		patchJSDOM(this.document);
		// Session timeout
		this.staleSessionTimeout = setInterval(() => {
			const now = Date.now();
			for (let session of this.sessions.values()) {
				if (now - session.lastMessageTime > 5 * 60 * 1000) {
					session.destroy().catch(escape);
				} else {
					session.archiveEvents(false).catch(escape);
				}
			}
		}, 10 * 1000);
	}
	async sessionFromId(sessionID: string | undefined, request: Request, allowNewSession: boolean) {
		if (!sessionID) {
			throw new Error("No session ID specified!");
		}
		let session = this.sessions.get(sessionID);
		if (session) {
			return session;
		}
		if (!this.destroying) {
			if (this.allowMultipleClientsPerSession) {
				let archive;
				try {
					archive = await Session.readArchivedSession(this.pathForSessionId(sessionID));
				} catch (e) {
				}
				if (archive) {
					session = new Session(this, sessionID, request);
					this.sessions.set(sessionID, session);
					await session.restoreFromArchive(archive as ArchivedSession);
					return session;
				}
			}
			if (allowNewSession) {
				session = new Session(this, sessionID, request);
				session.newClient(request);
				this.sessions.set(sessionID, session);
				return session;
			}
		}
		throw new Error("Session ID is not valid: " + sessionID);
	}
	pathForSessionId(sessionId: string) {
		return path.join(this.sessionsPath, encodeURIComponent(sessionId) + ".json");
	}
	async clientFromMessage(message: ClientMessage, request: Request, allowNewSession: boolean) {
		const clientID = message.clientID as number | 0;
		const session = await this.sessionFromId(message.sessionID, request, allowNewSession && message.messageID == 0 && clientID == 0);
		let client = session.clients.get(clientID);
		if (!client) {
			throw new Error("Client ID is not valid: " + message.clientID);
		}
		client.request = request;
		session.request = request;
		return client;
	}
	async newClient(request: Request) {
		if (this.destroying) {
			throw new Error("Cannot create new client while shutting down!");
		}
		for (;;) {
			const sessionID = uuid();
			if (!this.sessions.has(sessionID) && (!this.allowMultipleClientsPerSession || !await exists(this.pathForSessionId(sessionID)))) {
				const session = new Session(this, sessionID, request);
				this.sessions.set(sessionID, session);
				return session.newClient(request);
			}
		}
	}
	async destroyClientById(sessionID: string, clientID: number) {
		const session = this.sessions.get(sessionID);
		if (session) {
			const client = session.clients.get(clientID);
			if (client) {
				await client.destroy();
			}
		}
	}
	async destroy() {
		this.destroying = true;
		clearInterval(this.staleSessionTimeout);
		const promises: Promise<void>[] = [];
		for (let session of this.sessions.values()) {
			promises.push(session.destroy());
		}
		await Promise.all(promises);
	}
}
