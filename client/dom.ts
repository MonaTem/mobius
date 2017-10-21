import { createClientChannel, createClientPromise } from "mobius";
import { Channel } from "mobius-types";
import { defaultEventProperties } from "_dom";
import { stripDefaults, restoreDefaults } from "_internal";
import * as preact from "preact";
export { h, Component, AnyComponent, ComponentProps } from "preact";

type PreactNode = Node & {
	_listeners?: { [ event: string ]: (event: any) => void },
	__l?: { [ event: string ]: (event: any) => void },
	__c?: { [ event: string ]: [(event: any) => void, (event: any) => void, Channel] }
};

const preactOptions = preact.options as any;
preactOptions.nodeRemoved = (node: PreactNode) => {
	const c = node.__c;
	if (c) {
		ignore_nondeterminism:
		for (let name in c) {
			if (Object.hasOwnProperty.call(c, name)) {
				c[name][2].close();
				delete c[name];
			}
		}
	}
}

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
				}, send => {
					sender = send;
				}, undefined, name == "input", true);
				tuple = c[name] = [(event: any) => sender(stripDefaults(event, defaultEventProperties)), listener, channel];
			}
			listeners[name] = tuple[0];
		} else if (Object.hasOwnProperty.call(c, name)) {
			const channel = c[name][2];
			delete c[name];
			channel.close();
		}
	}
}

export function host(content: JSX.Element) : void {
	const element = document.body.children[0];
	preact.render(content, element, element.children[0]);
}

export function title(newTitle: string) : void {
	document.title = newTitle;
}

const requestedStyles: { [href: string]: Promise<void> } = {};

export function style(href: string) : Promise<void> {
	let result = requestedStyles[href];
	if (!result) {
		const link = self.document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		result = requestedStyles[href] = createClientPromise(() => new Promise<void>((resolve, reject) => {
			link.addEventListener("load", () => resolve(), false);
			link.addEventListener("error", () => {
				document.head.removeChild(link);
				reject(new Error("Failed to load styles from " + href + "!"));
			}, false);
		}), true);
		document.head.appendChild(link);
	}
	return result;
}

export function ref<T, V>(component: preact.Component<T, V>) : Element | null {
	return (component as any).base as Element | null;
}
