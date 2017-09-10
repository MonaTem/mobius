/**
 * @license THE MIT License (MIT)
 * 
 * Copyright (c) 2017 Ryan Petrich
 * Copyright (c) 2017 Dylan Piercey
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(() => {
	const supportsNativeXHR = "XMLHttpRequest" in window;
	const supportsActiveXObject = "ActiveXObject" in window;
	if (!supportsNativeXHR && !supportsActiveXObject) {
		return;
	}

	let isSending = 0;
	let anyChanged = false;
	let lastEventKey = "";
	let queuedEvents: string[] = [];

	const form = document.forms["mobius-form" as any as number] as HTMLFormElement;
	form.onsubmit = function() {
		return false;
	}

	function hasAncestor(potentialChild: Node, potentialAncestor: Element) {
		let node : Node | null = potentialChild;
		while (node = node.parentNode) {
			if (node === potentialAncestor) {
				return true;
			}
		}
		return false;
	}

	function onInputEvent(event: Event) {
		const element = (event.target || event.srcElement) as Element;
		if (element) {
			const type = event.type || "input";
			const key = (element.getAttribute && element.getAttribute(`data-mobius-on${type}`)) || (element as HTMLInputElement).name;
			const pair = key + "=" + encodeURIComponent((element as HTMLInputElement).value);
			if (lastEventKey == key) {
				queuedEvents.pop();
			} else {
				lastEventKey = key;
			}
			queuedEvents.push(pair);
		}
		anyChanged = true;
	}

	function onGenericEvent(event: Event) {
		send((event.target || event.srcElement) as HTMLElement, event.type || "click");
	}

	function handlerForEventType(onType: string) {
		switch (onType) {
			case "keydown":
			case "keyup":
			case "input":
			case "change":
				return onInputEvent;
			default:
				return onGenericEvent;
		}
	}

	function interceptElement(element: HTMLElement) {
		if (hasAncestor(element, form)) {
			const attributes = element.attributes;
			for (var i = 0; i < attributes.length; i++) {
				var match = attributes[i].name.match(/^data\-mobius\-on(.*)/);
				if (match) {
					var eventType = match[1];
					(element as any as { [eventName: string] : (this: HTMLElement, ev: Event) => any })["on" + eventType] = handlerForEventType(eventType);
				}
			}
		}
	}

	function interceptFormElements() {
		const elements = document.getElementsByTagName("*");
		for (var i = 0; i < elements.length; i++) {
			interceptElement(elements[i] as HTMLElement);
		}
		if (form["hasServerChannels"].value) {
			if (!isSending) {
				return send();
			}
		}
	}

	function send(target?: HTMLElement, eventType?: string) {
		var request: XMLHttpRequest = supportsNativeXHR ? new XMLHttpRequest() : new (window as any).ActiveXObject("MSXML2.XMLHTTP.3.0");
		request.open("POST", location.href, true);
		request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
		var body = queuedEvents;
		queuedEvents = [];
		lastEventKey = "";
		body.unshift("postback=js");
		for (let i = 0; i < form.length; i++) {
			const element = form[i];
			if (element.type == "hidden") {
				if (element.name != "postback" && element.name != "hasServerChannels") {
					body.push(element.name + "=" + encodeURIComponent(element.value));
				}
			}
		}
		if (target) {
			const name = target.getAttribute(`data-mobius-on${eventType}`) || (target as HTMLInputElement).name || target.getAttribute("name");
			if (name) {
				body.push(name + "=");
			}
		}
		request.onreadystatechange = function() {
			if (request.readyState == 4) {
				isSending--;
				if (request.status == 200) {
					if (anyChanged) {
						// Race condition, text field changed while the request was in flight, send again
						send();
					} else {
						(window as any).setDOM(form, request.responseText);
						// form.innerHTML = request.responseText;
						interceptFormElements();
					}
				}
			}
		}
		isSending++;
		anyChanged = false;
		request.send(body.join("&"));
		var messageID = form["messageID"];
		messageID.value = (messageID.value | 0) + 1;
	}

	interceptFormElements();

})()
