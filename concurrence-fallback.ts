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
	if (!("XMLHttpRequest" in window)) {
		return;
	}

	let isSending = 0;
	let anyChanged = false;

	const form = document.forms["concurrence-form" as any as number] as HTMLFormElement;
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

	function onKeyDown(event: Event) {
		const element = event.target || event.srcElement;
		if (element) {
			(element as any).changed = true;
		}
		anyChanged = true;
	}

	function onClick(event: Event) {
		send((event.target || event.srcElement) as HTMLElement);
	}

	function interceptElement(element: HTMLElement) {
		if (/^channelID\d+$/.test((element as any).name) && hasAncestor(element, form)) {
			if (element.nodeName == "INPUT" || element.nodeName == "TEXTAREA") {
				element.onkeydown = onKeyDown;
			} else {
				element.onclick = onClick;
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

	function send(target?: HTMLElement) {
		var request = new XMLHttpRequest();
		request.open("POST", location.href, true);
		request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
		var body = ["postback=js"];
		for (let i = 0; i < form.length; i++) {
			const element = form[i];
			if (element.name != "postback") {
				if (element.nodeName != "BUTTON") {
					if (element.type == "hidden" || element.changed) {
						delete element.changed;
						body.push(element.name + "=" + encodeURIComponent(element.value));
					}
				}
			}
		}
		if (target) {
			const name = (target as HTMLInputElement).name || target.getAttribute("name");
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
