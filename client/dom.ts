import { createClientChannel } from "concurrence";
import { ConcurrenceChannel } from "concurrence-types";
import * as preact from "preact";
export { h, cloneElement, Component, AnyComponent, ComponentProps } from "preact";

interface WrappedEvent {
	value?: string;
}

type PreactNode = Node & {
	_listeners?: { [ event: string ]: (event: any) => void },
	__l?: { [ event: string ]: (event: any) => void },
	__c?: { [ event: string ]: [(event: any) => void, (event: WrappedEvent) => void, ConcurrenceChannel] }
};

const preactOptions = preact.options as any;
preactOptions.nodeRemoved = (node: PreactNode) => {
	const c = node.__c;
	if (c) {
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
				const channel = createClientChannel((event: WrappedEvent) => {
					const listener = tuple[1];
					listener(event);
				}, send => {
					sender = (event: any) => send("value" in event.target ? { value: event.target.value } : {});
				}, undefined, name == "input", true);
				tuple = c[name] = [sender as (event: any) => void, listener, channel];
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
