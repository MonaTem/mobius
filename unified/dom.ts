namespace concurrence {
	export function render(selector: string, value: string) {
		if (document) {
			const element = document.querySelector(selector) as HTMLInputElement;
			if (element) {
				if ("value" in element) {
					element.value = value;
				}
				if (element.nodeName != "INPUT") {
					if ("textContent" in element) {
						element.textContent = value;
					} else if ("innerText" in element) {
						element.innerText = value;
					}
				}
			}
		}
	}
}
