package main

import (
	"bufio"
	"encoding/json"
	"regexp"
	"strings"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	log "github.com/sirupsen/logrus"
)

// Reads incoming messages from the device and subsequently publishes them to the provided MQTT topic
func deviceToMqtt(serialPort *bufio.Reader, mqttClient mqtt.Client, topic string) {
	for {
		message, err := serialPort.ReadString('\r')
		if err != nil {
			log.Error(err)
		}

		log.WithField("message", message).Trace("raw message received from device")

		// First, we remove the trailing \r and skip if the message is empty
		// Remove the trailing \r and skip if the message is empty
		message = strings.Replace(message, "\r", "", 1)
		if message == "" {
			continue
		}

		log.WithField("message", message).Debug("received message from device")

		jsonMessage := messageToJson(message)

		if jsonMessage.Command == "" {
			log.WithField("message", message).Debug("unsupported command, skipped")
			continue
		}

		publishToMqtt(mqttClient, topic, jsonMessage)
	}
}

// Takes the raw message as received from the device and converts it to json
// The device sends many more messages than we currently support, i.e. Main.IR.LearningDevice=Amp
// We simply ignore those commands for now.
func messageToJson(message string) JSONMessage {
	pattern := regexp.MustCompile(`Main.([A-Za-z]+)=(.*)`)
	matches := pattern.FindStringSubmatch(message)
	serialMessage := SerialMessage{
		Command: "",
		Value:   "",
	}
	if matches == nil {
		serialMessage = SerialMessage{
			Command: strings.ReplaceAll(message, "Main.", ""),
			Value:   message,
		}
	} else {
		serialMessage = SerialMessage{
			Command: matches[1],
			Value:   matches[2],
		}

	}
	var jsonMessage JSONMessage
	switch serialMessage.Command {
	case "Power":
		jsonMessage = readPower(serialMessage)
	case "Volume":
		jsonMessage = readVolume(serialMessage)
	case "Mute":
		jsonMessage = readMute(serialMessage)
	case "Source":
		jsonMessage = readSource(serialMessage)
	case "Speakera", "Speakerb":
		jsonMessage = readSpeaker(serialMessage)

	case "Volume+", "Volume-":
		jsonMessage = readVolumeLegacy(serialMessage)
	default:
		return JSONMessage{}
	}

	return jsonMessage
}

// Publish a message to the mqtt broker
func publishToMqtt(client mqtt.Client, topic string, jsonStruct JSONMessage) {
	jsonData, _ := json.Marshal(jsonStruct)
	jsonString := string(jsonData)

	token := client.Publish(topic, 0, false, jsonString)
	token.Wait()

	log.WithFields(log.Fields{
		"json":  jsonString,
		"topic": topic,
	}).Debug("published to mqtt")
}
