import { defaultEventProperties } from "_dom";
import { registeredListeners } from "_dom";
import { restoreDefaults, stripDefaults } from "_internal";
import { createClientChannel } from "mobius";
import { Channel } from "mobius-types";
import * as preact from "preact";
export { h, Component, ComponentFactory, ComponentProps, FunctionalComponent } from "preact";

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

export function _host(content: JSX.Element): void {
	const element = document.body.children[0];
	preact.render(content, element, element.children[0]);
}

export function title(newTitle: string): void {
	document.title = newTitle;
}

export function ref<T, V>(component: preact.Component<T, V>): Element | null {
	return (component as any).base as Element | null;
}
