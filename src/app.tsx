class ShowHideWidget extends preact.Component<{}, { visible: boolean }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { visible: false };
	}
	render(props: preact.ComponentProps<this>) {
		if (this.state.visible) {
			return <div><button onClick={this.hide}>Hide</button><div>{props.children}</div></div>
		} else {
			return <div><button onClick={this.show}>Show</button></div>
		}
	}
	show = () => this.setState({ visible: true })
	hide = () => this.setState({ visible: false })
}


class RandomWidget extends preact.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		console.log("Generating random numbers");
		this.state = { value: "" };
		this.updateRandom();
	}
	updateRandom = () => {
		concurrence.random().then(value => {
			console.log(value);
			this.setState({ value: value.toString() });
		});
	}
	randomChannel: ConcurrenceChannel = concurrence.interval(this.updateRandom, 1000);
	render() {
		return <span>So random: {this.state.value}</span>;
	}
	componentWillUnmount() {
		console.log("Destroying random stream");
		this.randomChannel.close();
	}
}


class TextField extends preact.Component<{ value: string, onChange: (value: string) => void }, { value: string }> {
	onChange = (event: any) => {
		this.props.onChange(event.value as string);
	}
	render() {
		return <input value={this.props.value} onChange={this.onChange} onInput={this.onChange}/>
	}
}


class ReceiveWidget extends preact.Component<{}, { messages: string[] }> {
	constructor(props: any, context: any) {
		super(props, context);
		console.log("Receiving messages");
		this.state = { messages: [] };
	}
	receiveChannel: ConcurrenceChannel = concurrence.receive("messages", value => {
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

class BroadcastWidget extends preact.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { value: "" };
	}
	render() {
		return (
			<div>
				<TextField value={this.state.value} onChange={this.updateValue}/>
				<button onClick={this.send}>Send</button>
			</div>
		);
	}
	updateValue = (value: string) => this.setState({ value })
	send = () => {
		concurrence.broadcast("messages", this.state.value);
	}
}

type DbRecord = { id: number };
type DbRecordChange<T extends DbRecord> = ConcurrenceJsonMap & {
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

class NewItemWidget extends preact.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { value: "" };
	}
	render() {
		return (
			<div>
				<TextField value={this.state.value} onChange={this.onChange} />
				<button onClick={this.send}>Add</button>
			</div>
		);
	}
	onChange = (value: string) => this.setState({ value })
	send = () => {
		concurrence.mysql.modify("localhost", "INSERT INTO concurrence_todo.items (text) VALUES (?)", this.state.value).then(result => {
			const message: DbRecordChange<Item> = {
				operation: "create",
				record: { id: result.insertId as number, text: this.state.value }
			};
			concurrence.broadcast("item-changes", message);
			this.setState({ value: "" });
		}).catch(e => console.log(e));
	}
}

class ItemWidget extends preact.Component<{ item: Item }, { pendingText: string | undefined, inProgress: boolean }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { pendingText: undefined, inProgress: false };
	}
	render() {
		return (
			<div>
				<TextField value={typeof this.state.pendingText != "undefined" ? this.state.pendingText : this.props.item.text} onChange={this.setPendingText}/>
				<button onClick={this.delete} disabled={this.state.inProgress}>Delete</button>
				{typeof this.state.pendingText != "undefined" ? <button onClick={this.save} disabled={this.state.inProgress}>Save</button> : null}
			</div>
		);
	}
	setPendingText = (pendingText: string) => {
		this.setState({ pendingText : pendingText != this.props.item.text ? pendingText : undefined })
	}
	save = () => {
		if (typeof this.state.pendingText != "undefined") {
			const message: DbRecordChange<Item> = {
				operation: "modify",
				record: { id: this.props.item.id, text: this.state.pendingText }
			};
			this.setState({ inProgress: true });
			concurrence.mysql.modify("localhost", "UPDATE concurrence_todo.items SET text = ? WHERE id = ?", this.state.pendingText, this.props.item.id).then(result => {
				concurrence.broadcast("item-changes", message);
				this.setState({ pendingText: undefined, inProgress: false });
			}).catch(e => console.log(e));
		}
	}
	delete = () => {
		this.setState({ inProgress: true });
		const message: DbRecordChange<Item> = {
			operation: "delete",
			record: this.props.item
		};
		concurrence.mysql.modify("localhost", "DELETE FROM concurrence_todo.items WHERE id = ?", this.props.item.id).then(result => {
			concurrence.broadcast("item-changes", message);
			this.setState({ inProgress: false });
		});
	}
}

class ListWidget<T extends DbRecord> extends preact.Component<{ fetch: () => PromiseLike<T[]> | T[], topic: string, render: (record: T) => JSX.Element | null }, { records: T[], message: string | undefined }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { records: [], message: "Loading..." };
		this.receiveChannel = concurrence.receive(this.props.topic, (change: DbRecordChange<T>) => {
			this.setState({ records: updatedRecordsFromChange(this.state.records, change) });
		});
		Promise.resolve(this.props.fetch()).then(records => this.setState({ records, message: undefined })).catch(e => this.setState({ message: e.toString() }));
	}
	render() {
		return <div>{typeof this.state.message != "undefined" ? this.state.message : this.state.records.map(this.props.render)}</div>;
	}
	receiveChannel: ConcurrenceChannel;
	componentWillUnmount() {
		this.receiveChannel.close();
	}
}

const ItemsWidget = () => <ListWidget fetch={() => concurrence.mysql.query("localhost", "SELECT id, text FROM concurrence_todo.items ORDER BY id DESC")} render={(item: Item) => <ItemWidget item={item} key={item.id}/>} topic="item-changes" />;


concurrence.host((
	<div>
		<strong>Random numbers:</strong>
		<ShowHideWidget>
			<RandomWidget/>
		</ShowHideWidget>
		<strong>Messaging:</strong>
		<ShowHideWidget>
			<ReceiveWidget/>
		</ShowHideWidget>
		<BroadcastWidget/>
		<strong>To Do App:</strong>
		<ShowHideWidget>
			<NewItemWidget/>
			<ItemsWidget/>
		</ShowHideWidget>
	</div>
));

// Log current time
concurrence.now().then(value => console.log(value));
