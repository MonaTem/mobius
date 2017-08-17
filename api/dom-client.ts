/// <reference types="preact" />

namespace concurrence {

	type PreactNode = Node & {
		__l?: { [ event: string ]: (event: any) => void },
		__c?: { [ event: string ]: [ConcurrenceLocalChannel<any>, (event: any) => void] }
	};

	const preactOptions = preact.options as any;
	preactOptions.nodeRemoved = (node: PreactNode) => {
		const c = node.__c;
		if (c) {
			for (let name in c) {
				if (Object.hasOwnProperty.call(c, name)) {
					c[name][0].close();
					delete c[name];
				}
			}
		}
	}

	preactOptions.listenerUpdated = (node: PreactNode, name: string) => {
		const listeners = node.__l;
		if (listeners) {
			const c = node.__c || (node.__c = {});
			if (Object.hasOwnProperty.call(listeners, name)) {
				const listener = listeners[name];
				let tuple = c[name];
				if (tuple) {
					tuple[1] = listener;
				} else {
					tuple = c[name] = [concurrence.observeClientEventCallback(function() {
						return tuple[1].apply(null, [].slice.call(arguments));
					}, true), listener];
				}
				listeners[name] = event => {
					if ("value" in event.target) {
						tuple[0].send({ value: event.target.value });
					} else {
						tuple[0].send({});
					}
				}
			} else if (Object.hasOwnProperty.call(c, name)) {
				c[name][0].close();
				delete c[name];
			}
		}
	}

}
