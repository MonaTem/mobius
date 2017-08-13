class StartStopWidget extends preact.Component<{}, { started: boolean }> {
	constructor(props: any, context: any) {
		super(props, context);
		this.state = { started: false };
	}
	render(props: preact.ComponentProps<this>) {
		if (this.state.started) {
			return <div><button onClick={() => this.setState({ started: false })}>Stop</button><div>{props.children}</div></div>
		} else {
			return <div><button onClick={() => this.setState({ started: true })}>Start</button></div>
		}
	}
}

class RandomWidget extends preact.Component<{}, { value: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		console.log("Generating random numbers");
		this.state = { value: "" };
		this.updateRandom();
	}
	randomChannel: ConcurrenceChannel = concurrence.interval(() => this.updateRandom(), 1000);
	updateRandom() {
		concurrence.random().then(value => {
			console.log(value);
			this.setState({ value: value.toString() });
		});
	}
	render() {
		return <span>So random: {this.state.value}</span>;
	}
	componentWillUnmount() {
		console.log("Destroying random stream");
		this.randomChannel.close();
	}
}

class ReceiveWidget extends preact.Component<{}, { message: string }> {
	constructor(props: any, context: any) {
		super(props, context);
		console.log("Receiving messages");
		this.state = { message: "" };
	}
	receiveChannel: ConcurrenceChannel = concurrence.receive(value => {
		console.log("Received: " + value);
		this.setState({ message: "Received: " + value });
	});
	render() {
		return <span>{this.state.message}</span>;
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
				<input value={this.state.value} onChange={(event: any) => this.setState({ value: event.value })}/>
				<button onClick={this.send.bind(this)}>Send</button>
			</div>
		);
	}
	send() {
		concurrence.broadcast(this.state.value);
	}
}

concurrence.render((
	<div>
		<strong>Random numbers:</strong>
		<StartStopWidget>
			<RandomWidget/>
		</StartStopWidget>
		<strong>Messaging:</strong>
		<StartStopWidget>
			<ReceiveWidget/>
		</StartStopWidget>
		<BroadcastWidget/>
	</div>
), "#host");

// Basic MySQL driver test
concurrence.mysql.query("localhost", "SELECT 1 + 1 AS solution").then(result => console.log(result)).catch(error => console.log("error", error));

// Log current time
concurrence.now().then(value => console.log(value));
