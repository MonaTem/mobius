import { Channel, JsonMap } from "mobius-types";
import * as dom from "dom";
import { receive, send } from "broadcast";
import * as sql from "sql";
import { shareSession } from "mobius";
import { secret } from "redact";

const database = secret<sql.Credentials>("mysql", "localhost");

class CollapsibleSection extends dom.Component<{ title: string }, { visible?: boolean }> {
	render() {
		if (this.state.visible) {
			return <div>
				<h2 class="active">
					<button onClick={() => this.setState({ visible: false })}>{this.props.title}</button>
				</h2>
				<div>{this.props.children}</div>
			</div>
		} else {
			return <div>
				<h2 class="inactive">
					<button onClick={() => this.setState({ visible: true })}>{this.props.title}</button>
				</h2>
			</div>
		}
	}
}


class RandomWidget extends dom.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		console.log("Generating random numbers");
		this.state = { value: "" };
		this.updateRandom();
	}
	updateRandom = () => {
		let value = Math.random();
		console.log(value);
		this.setState({ value: value.toString() });
	}
	interval = setInterval(this.updateRandom, 1000);
	render() {
		return <span>So random: <span>{this.state.value}</span></span>;
	}
	componentWillUnmount() {
		console.log("Destroying random stream");
		clearInterval(this.interval);
	}
}


class TextField extends dom.Component<{ value: string, placeholder?: string, onChange: (value: string) => void, onEnter: () => void }, { value: string }> {
	onChange(event: any) {
		this.props.onChange(event.value as string);
	}
	onKeyPress(event: any) {
		if (event.keyCode == 13 && this.props.onEnter) {
			this.props.onEnter();
		}
	}
	render() {
		return <input placeholder={this.props.placeholder || ""} value={this.props.value} onChange={this.onChange.bind(this)} onInput={this.onChange.bind(this)} onKeyPress={this.props.onEnter ? this.onKeyPress : undefined}/>
	}
}


class ReceiveWidget extends dom.Component<{}, { messages: string[] }> {
	constructor(props: any, context: any) {
		super(props, context);
		console.log("Receiving messages");
		this.state = { messages: [] };
	}
	receiveChannel: Channel = receive("messages", value => {
		console.log("Received: " + value);
		this.setState({ messages: [value as string].concat(this.state.messages) });
	});
	render() {
		const messages = this.state.messages;
		return <span>{messages.length > 0 ? messages.map(message => <div>{message}</div>) : "No Messages"}</span>;
	}
	componentWillUnmount() {
		console.log("Destroying message stream");
		this.receiveChannel.close();
	}
}

class BroadcastWidget extends dom.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { value: "" };
	}
	render() {
		return (
			<div>
				<TextField value={this.state.value} onChange={this.updateValue} onEnter={this.send}/>
				<button onClick={this.send}>Send</button>
			</div>
		);
	}
	updateValue = (value: string) => this.setState({ value })
	send = () => {
		send("messages", this.state.value);
	}
}

type DbRecord = { id: number };
type DbRecordChange<T extends DbRecord> = JsonMap & {
	operation: "create" | "modify" | "delete";
	record: T;
};

function updatedRecordsFromChange<T extends DbRecord>(items: T[], message: DbRecordChange<T>) {
	switch (message.operation) {
		case "create": {
			let found = false;
			items = items.map(item => {
				if (item.id == message.record.id) {
					found = true;
					return message.record;
				}
				return item;
			});
			if (!found) {
				items.unshift(message.record);
			}
			return items;
		}
		case "modify":
			return items.map(item => item.id == message.record.id ? message.record : item);
		case "delete":
			return items.filter(item => item.id != message.record.id);
	}
}

type Item = DbRecord & { text: string };

class NewItemWidget extends dom.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { value: "" };
	}
	render() {
		return (
			<div>
				<TextField placeholder="New Item" value={this.state.value} onChange={this.onChange.bind(this)} onEnter={this.send.bind(this)} />
				<button onClick={this.send}>Add</button>
			</div>
		);
	}
	onChange(value: string) {
		this.setState({ value });
	}
	send() {
		sql.modify(database, "INSERT INTO mobius_todo.items (text) VALUES (?)", [this.state.value]).then(result => {
			const message: DbRecordChange<Item> = {
				operation: "create",
				record: { id: result.insertId as number, text: this.state.value }
			};
			send("item-changes", message);
			this.setState({ value: "" });
		}).catch(e => console.log(e));
	}
}

class ItemWidget extends dom.Component<{ item: Item }, { pendingText: string | undefined, inProgress: boolean }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { pendingText: undefined, inProgress: false };
	}
	render() {
		return (
			<div>
				<TextField value={typeof this.state.pendingText != "undefined" ? this.state.pendingText : this.props.item.text} onChange={this.setPendingText.bind(this)} onEnter={this.save.bind(this)}/>
				<button onClick={this.save.bind(this)} class={typeof this.state.pendingText != "undefined" ? "save-dirty" : "save-clean"} disabled={this.state.inProgress}>Save</button>
				<button onClick={this.delete.bind(this)} disabled={this.state.inProgress}>Delete</button>
			</div>
		);
	}
	setPendingText(pendingText: string) {
		this.setState({ pendingText : pendingText != this.props.item.text ? pendingText : undefined })
	}
	save() {
		if (typeof this.state.pendingText != "undefined") {
			this.setState({ inProgress: true });
			sql.modify(database, "UPDATE mobius_todo.items SET text = ? WHERE id = ?", [this.state.pendingText, this.props.item.id]).then(result => {
				send("item-changes", {
					operation: "modify",
					record: { id: this.props.item.id, text: this.state.pendingText }
				} as DbRecordChange<Item>);
				this.setState({ pendingText: undefined, inProgress: false });
			}).catch(e => console.log(e));
		}
	}
	delete() {
		this.setState({ inProgress: true });
		sql.modify(database, "DELETE FROM mobius_todo.items WHERE id = ?", [this.props.item.id]).then(result => {
			send("item-changes", {
				operation: "delete",
				record: this.props.item
			} as DbRecordChange<Item>);
			this.setState({ inProgress: false });
		});
	}
}

class ListWidget<T extends DbRecord> extends dom.Component<{ fetch: () => PromiseLike<T[]> | T[], topic: string, render: (record: T) => JSX.Element | null }, { records: T[], message: string | undefined }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { records: [], message: "Loading..." };
		this.receiveChannel = receive(this.props.topic, (change: DbRecordChange<T>) => {
			this.setState({ records: updatedRecordsFromChange(this.state.records, change) });
		});
		Promise.resolve(this.props.fetch()).then(records => this.setState({ records, message: undefined })).catch(e => this.setState({ message: e.toString() }));
	}
	render() {
		return <div>{typeof this.state.message != "undefined" ? this.state.message : this.state.records.map(this.props.render)}</div>;
	}
	receiveChannel: Channel;
	componentWillUnmount() {
		this.receiveChannel.close();
	}
}

const ItemsWidget = () => <ListWidget fetch={() => sql.query(database, "SELECT id, text FROM mobius_todo.items ORDER BY id DESC")} render={(item: Item) => <ItemWidget item={item} key={item.id}/>} topic="item-changes" />;

class SharingWidget extends dom.Component<{}, { url?: string, error?: any }> {
	constructor(props: any, context: any) {
		super(props, context);
		shareSession().then(url => this.setState({ url })).catch(error => this.setState({ error }));
	}
	render() {
		if (this.state.error) {
			return <span>{this.state.error.toString()}</span>
		}
		if (this.state.url) {
			return <a href={this.state.url} target="_blank">Share</a>
		}
		return <span>Loading...</span>
	}
}

class ErrorBoundary extends dom.Component<{}, { error?: string }> {
	componentWillReceiveProps(nextProps: any) {
		if (nextProps.children) {
			this.setState({ error: undefined });
		}
	}
	componentDidCatch(error: any) {
		this.setState({ error: error + "" });
	}
	render() {
		if (this.state.error) {
			return <div>{this.state.error}</div>
		} else {
			return <div>{this.props.children}</div>
		}
	}
}

dom.host((
	<div>
		<h1>Mobius Sample App</h1>
		<CollapsibleSection title="To Do List">
			<NewItemWidget/>
			<ErrorBoundary>
				<ItemsWidget/>
			</ErrorBoundary>
		</CollapsibleSection>
		<CollapsibleSection title="Random Stream">
			<RandomWidget/>
		</CollapsibleSection>
		<CollapsibleSection title="Messaging">
			<ErrorBoundary>
				<ReceiveWidget/>
			</ErrorBoundary>
			<BroadcastWidget/>
		</CollapsibleSection>
		<CollapsibleSection title="Session Sharing">
			<ErrorBoundary>
				<SharingWidget/>
			</ErrorBoundary>
		</CollapsibleSection>
		<div class="about">made with <span class="heart">♥️</span> by <a href="https://twitter.com/rpetrich/">@rpetrich</a></div>
	</div>
));

dom.style("app.css");

// Log current time
console.log("Date.now()", Date.now());
console.log("new Date()", new Date().toString());
console.log("Math.random", Math.random());
