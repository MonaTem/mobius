import { defaultEventProperties } from "_dom";
import { restoreDefaults, stripDefaults } from "_internal";
import { createClientChannel, createClientPromise } from "mobius";
import { Channel } from "mobius-types";
import * as preact from "preact";
export { h, Component, AnyComponent, ComponentProps } from "preact";

const registeredListeners: { [ eventId: number ]: (event: any) => void } = {};

export function dispatchRacedEvents(defer: () => void) {
	const resolved = Promise.resolve();
	const racedEvents = (window as any)._mobiusEvents as ReadonlyArray<[number, any]>;
	if (racedEvents) {
		return racedEvents.reduce((promise, event) => promise.then(() => registeredListeners[event[0]](event[1])).then(defer), resolved);
	} else {
		return resolved;
	}
}

type PreactNode = Node & {
	_listeners?: { [ event: string ]: (event: any) => void },
	__l?: { [ event: string ]: (event: any) => void },
	__c?: { [ event: string ]: [(event: any) => void, (event: any) => void, Channel] },
};

const preactOptions = preact.options as any;
preactOptions.nodeRemoved = (node: PreactNode) => {
	const c = node.__c;
	if (c) {
		ignore_nondeterminism:
		for (const name in c) {
			if (Object.hasOwnProperty.call(c, name)) {
				c[name][2].close();
				delete c[name];
			}
		}
	}
};

preactOptions.listenerUpdated = (node: PreactNode, name: string) => {
	const listeners = node._listeners || node.__l;
	if (listeners) {
		const c = node.__c || (node.__c = {});
		if (Object.hasOwnProperty.call(listeners, name)) {
			const listener = listeners[name];
			let tuple = c[name];
			if (tuple) {
				tuple[1] = listener;
			} else {
				let sender: any;
				const channel = createClientChannel((event: any) => {
					tuple[1](restoreDefaults(event, defaultEventProperties));
				}, (send) => {
					sender = send;
				}, undefined, name == "input", true);
				tuple = c[name] = [registeredListeners[channel.channelId] = (event: any) => sender(stripDefaults(event, defaultEventProperties)), listener, channel];
			}
			listeners[name] = tuple[0];
		} else if (Object.hasOwnProperty.call(c, name)) {
			const channel = c[name][2];
			delete registeredListeners[channel.channelId];
			delete c[name];
			channel.close();
		}
	}
};

export function host(content: JSX.Element): void {
	const element = document.body.children[0];
	preact.render(content, element, element.children[0]);
}

export function title(newTitle: string): void {
	document.title = newTitle;
}

const requestedStyles: { [href: string]: Promise<void> } = {};

export function style(href: string, subresourceIntegrity?: string): Promise<void> {
	let result = requestedStyles[href];
	if (!result) {
		result = requestedStyles[href] = createClientPromise(() => new Promise<void>((resolve, reject) => {
			let link: HTMLLinkElement | undefined;
			const existingStyles = document.getElementsByTagName("link");
			for (let i = 0; i < existingStyles.length; i++) {
				if (existingStyles[i].getAttribute("href") === href && "sheet" in existingStyles[i]) {
					if (existingStyles[i].sheet) {
						return resolve();
					}
					link = existingStyles[i];
				}
			}
			if (!link) {
				link = self.document.createElement("link");
				link.rel = "stylesheet";
				link.href = href;
				if (subresourceIntegrity) {
					link.setAttribute("integrity", subresourceIntegrity);
				}
				document.body.appendChild(link);
			}
			link.addEventListener("load", () => resolve(), false);
			link.addEventListener("error", () => {
				document.body.removeChild(link!);
				reject(new Error("Failed to load styles from " + href + "!"));
			}, false);
		}), true);
	}
	return result;
}

export function ref<T, V>(component: preact.Component<T, V>): Element | null {
	return (component as any).base as Element | null;
}
