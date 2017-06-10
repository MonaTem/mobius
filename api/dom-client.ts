namespace concurrence {
	export function observe(selector: string, event: string, callback: () => void) : ConcurrenceTransaction {
		const transaction = concurrence.observeClientEventCallback(callback);
		const elements = document.querySelectorAll(selector);
		for (var i = 0; i < elements.length; i++) {
			elements[i].addEventListener(event, () => transaction.send(), false);
		}
		return transaction;
	}
	export function read(selector: string) : Promise<string> {
		const element: any = document.querySelector(selector);
		return concurrence.observeClientPromise(element && "value" in element ? Promise.resolve(element.value) : Promise.reject("Selector not found!"));
	}
}
