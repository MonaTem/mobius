// Basic render of static data
concurrence.render("#host", "Loading...");

// Basic fetch of data from the server
Promise.all([concurrence.random(), concurrence.random()]).then(function(value) {
	console.log(value);
	concurrence.render("#host", JSON.stringify(value));
});

// Stream of events from server to client
var randomStream;
function toggleStream() {
	if (randomStream) {
		console.log("Destroying random stream");
		randomStream.destroy();
		randomStream = null;
	} else {
		console.log("Starting random stream");
		randomStream = concurrence.interval(function() {
			concurrence.random().then(function(value) {
				concurrence.render("#host", value);
				console.log(value);
			});
		}, 1000);
	}
	concurrence.render("#toggle", randomStream ? "Stop" : "Start");
}
toggleStream();
var toggleTransaction = concurrence.observe("#toggle", "click", toggleStream);

// Read input from the client
var logTransaction = concurrence.observe("#log", "click", function() {
	concurrence.read("#input").then(function(value) {
		console.log("Read input: " + value);
	});
});

// Receive broadcasted values
var receiveTransaction = concurrence.receive(function(value) {
	console.log("Receiving: " + value);
	concurrence.render("#broadcastField", value);
});

// Broadcast when button is pressed
var broadcastTransaction = concurrence.observe("#broadcast", "click", function() {
	concurrence.read("#broadcastField").then(function(value) {
		if (value.length == 0) {
			console.log("Disabling broadcast");
			receiveTransaction.destroy();
			broadcastTransaction.destroy();
			concurrence.render("#broadcast", "Disabled");
		} else {
			console.log("Broadcasting: " + value);
			concurrence.broadcast(value);
		}
	});
});

// Disconnect all events
var disconnectTransaction = concurrence.observe("#disconnect", "click", function() {
	// Force disconnect
	//concurrence.disconnect();
	// Graceful disconnect by destroying all server-side streams
	if (randomStream) {
		toggleStream();
	}
	broadcastTransaction.destroy();
	receiveTransaction.destroy();
	disconnectTransaction.destroy();
	toggleTransaction.destroy();
	logTransaction.destroy();
});
