// Basic render of static data
concurrence.client.render("#host", "Loading...");

// Basic fetch of data from the server
Promise.all([concurrence.server.random(), concurrence.server.random()]).then(function(value) {
	console.log(value);
	concurrence.client.render("#host", JSON.stringify(value));
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
		randomStream = concurrence.server.interval(function() {
			concurrence.server.random().then(function(value) {
				concurrence.client.render("#host", value);
			});
		}, 1000);
	}
	concurrence.client.render("#toggle", randomStream ? "Stop" : "Start");
}
toggleStream();
var toggleTransaction = concurrence.client.observe("#toggle", "click", toggleStream);

// Read input from the client
var logTransaction = concurrence.client.observe("#log", "click", function() {
	concurrence.client.read("#input").then(function(value) {
		console.log("Read input: " + value);
	});
});

// Disconnect all events
var disconnectTransaction = concurrence.client.observe("#disconnect", "click", function() {
	// Force disconnect
	//concurrence.disconnect();
	// Graceful disconnect by destroying all server-side streams
	if (randomStream) {
		toggleStream();
	}
	disconnectTransaction.destroy();
	toggleTransaction.destroy();
	logTransaction.destroy();
});
