---
title: Listening to events
lang: en
slug: event-listening
order: 3
---

## Listening to events

You can listen to [any Events API event](https://api.slack.com/events) using the `event()` method after subscribing to it in your app configuration. This allows your app to take action when something happens in Slack, like a user reacting to a message or joining a channel.

The `event()` method requires an `eventType` of type string.

```javascript
const welcomeChannelId = 'C12345';

// When a user joins the team, send a message in a predefined channel asking them to introduce themselves
app.event('team_join', async ({ event, client }) => {
  try {
    // Call chat.postMessage with the built-in client
    const result = await client.chat.postMessage({
      channel: welcomeChannelId,
      text: `Welcome to the team, <@${event.user.id}>! 🎉 You can introduce yourself in this channel.`
    });
    console.log(result);
  }
  catch (error) {
    console.error(error);
  }
});
```

#### Filtering on message subtypes</h4>

A `message()` listener is equivalent to `event('message')`

You can filter on subtypes of events by using the built-in `subtype()` middleware. Common message subtypes like `bot_message` and `message_replied` can be found [on the message event page](https://api.slack.com/events/message#message_subtypes).

```javascript
// Matches all messages from bot users
app.message(subtype('bot_message'), ({ message }) => {
  console.log(`The bot user ${message.user} said ${message.text}`);
});
```