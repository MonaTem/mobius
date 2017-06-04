/// <reference path="concurrence.ts" />

namespace concurrence {
	export function render(selector: string, value: string) {
		var element: any = document.querySelector(selector);
		if (element) {
			if ("value" in element) {
				element.value = value;
			}
			if ("innerText" in element && element.nodeName != "INPUT") {
				element.innerText = value;
			}
		}
	}
	export function observe(selector: string, event: string, callback: () => void) : ConcurrenceTransaction {
		var transaction = concurrence.observeClientEventCallback(callback);
		var elements = document.querySelectorAll(selector);
		for (var i = 0; i < elements.length; i++) {
			elements[i].addEventListener(event, () => transaction.send(), false);
		}
		return transaction;
	}
	export function read(selector: string) : Promise<string> {
		var element: any = document.querySelector(selector);
		return concurrence.observeClientPromise(element && "value" in element ? Promise.resolve(element.value) : Promise.reject("Selector not found!"));
	}
}
