// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as log from "./log";
import { WebSocketImpl } from "rhea-promise";
import {
  DataTransformer,
  TokenCredential,
  EventHubConnectionConfig,
  SharedKeyCredential,
  ConnectionConfig,
  isTokenCredential,
  RetryOptions,
  Constants,
  parseConnectionString,
  EventHubConnectionStringModel
} from "@azure/core-amqp";

import { ConnectionContext } from "./connectionContext";
import { PartitionProperties, EventHubProperties } from "./managementClient";
import { EventPosition } from "./eventPosition";

import { IotHubClient } from "./iothub/iothubClient";
import { AbortSignalLike } from "@azure/abort-controller";
import { EventHubProducer } from "./sender";
import { EventHubConsumer } from "./receiver";
import { throwTypeErrorIfParameterMissing, throwErrorIfConnectionClosed } from "./util/error";

export function getRetryAttemptTimeoutInMs(retryOptions: RetryOptions | undefined): number {
  const timeoutInMs =
    retryOptions == undefined ||
    typeof retryOptions.timeoutInMs !== "number" ||
    !isFinite(retryOptions.timeoutInMs) ||
    retryOptions.timeoutInMs < Constants.defaultOperationTimeoutInMs
      ? Constants.defaultOperationTimeoutInMs
      : retryOptions.timeoutInMs;
  return timeoutInMs;
}

/**
 * The set of options to configure the behavior of an `EventHubProducer`.
 * These can be specified when creating the producer via the `createProducer` method.
 * - `partitionId`  : The string identifier of the partition that the producer can be bound to.
 * - `retryOptions` : The retry options used to govern retry attempts when an issue is encountered while sending events.
 * A simple usage can be `{ "maxRetries": 4 }`.
 */
export interface EventHubProducerOptions {
  /**
   * @property
   * The identifier of the partition that the producer will be bound to.
   * If a value is provided, all events sent using the producer will reach the same partition.
   * If no value is provided, the service will determine the partition to which the event will be sent.
   */
  partitionId?: string;
  /**
   * @property
   * The retry options used to govern retry attempts when an issue is encountered while sending events.
   * If no value is provided here, the retry options set when creating the `EventHubClient` is used.
   */
  retryOptions?: RetryOptions;
}

/**
 * The set of options to configure the `send` operation on the `EventHubProducer`.
 * - `partitionKey` : A value that is hashed to produce a partition assignment.
 * - `abortSignal`  : A signal the request to cancel the send operation.
 */
export interface SendOptions {
  /**
   * @property
   * A value that is hashed to produce a partition assignment.
   * It guarantees that messages with the same partitionKey end up in the same partition.
   * Specifying this will throw an error if the producer was created using a `paritionId`.
   */
  partitionKey?: string | null;
  /**
   * @property
   * An implementation of the `AbortSignalLike` interface to signal the request to cancel the operation.
   * For example, use the &commat;azure/abort-controller to create an `AbortSignal`.
   */
  abortSignal?: AbortSignalLike;
}

/**
 * The set of options to configure the `createBatch` operation on the `EventProducer`.
 * - `partitionKey`  : A value that is hashed to produce a partition assignment.
 * Not applicable if the `EventHubProducer` was created using a `partitionId`.
 * - `maxSizeInBytes`: The upper limit for the size of batch. The `tryAdd` function will return `false` after this limit is reached.
 * - `abortSignal`   : A signal the request to cancel the send operation.
 */
export interface BatchOptions {
  /**
   * @property
   * A value that is hashed to produce a partition assignment.
   * It guarantees that messages with the same partitionKey end up in the same partition.
   * Specifying this will throw an error if the producer was created using a `paritionId`.
   */
  partitionKey?: string;
  /**
   * @property
   * The upper limit for the size of batch. The `tryAdd` function will return `false` after this limit is reached.
   */
  maxSizeInBytes?: number;
  /**
   * @property
   * An implementation of the `AbortSignalLike` interface to signal the request to cancel the operation.
   * For example, use the &commat;azure/abort-controller to create an `AbortSignal`.
   */
  abortSignal?: AbortSignalLike;
}

/**
 * The set of options to configure the behavior of an `EventHubConsumer`.
 * These can be specified when creating the consumer using the `createConsumer` method.
 * - `ownerLevel`  : A number indicating that the consumer intends to be an exclusive consumer of events resulting in other
 * consumers to fail if their `ownerLevel` is lower or doesn't exist.
 * - `retryOptions`: The retry options used to govern retry attempts when an issue is encountered while receiving events.
 * A simple usage can be `{ "maxRetries": 4 }`.
 */
export interface EventHubConsumerOptions {
  /**
   * @property
   * The owner level associated with an exclusive consumer.
   *
   * When provided, the owner level indicates that a consumer is intended to be the exclusive receiver of events for the
   * requested partition and the associated consumer group.
   * When multiple consumers exist for the same partition/consumer group pair, then the ones with lower or no
   * `ownerLevel` will get a `ReceiverDisconnectedError` during the next attempted receive operation.
   */
  ownerLevel?: number;
  /**
   * @property
   * The retry options used to govern retry attempts when an issue is encountered while receiving events.
   * If no value is provided here, the retry options set when creating the `EventHubClient` is used.
   */
  retryOptions?: RetryOptions;
}

/**
 * Describes the options that can be provided while creating the EventHubClient.
 * - `dataTransformer`: A set of `encode`/`decode` methods to be used to encode an event before sending to service
 * and to decode the event received from the service
 * - `userAgent`      : A string to append to the built in user agent string that is passed as a connection property
 * to the service.
 * - `websocket`      : The WebSocket constructor used to create an AMQP connection if you choose to make the connection
 * over a WebSocket.
 * - `webSocketConstructorOptions` : Options to pass to the Websocket constructor when you choose to make the connection
 * over a WebSocket.
 * - `retryOptions`   : The retry options for all the operations on the client/producer/consumer.
 * A simple usage can be `{ "maxRetries": 4 }`.
 * @interface ClientOptions
 */
export interface EventHubClientOptions {
  /**
   * @property
   * The data transformer that will be used to encode and decode the sent and received messages respectively.
   * If not provided then the `DefaultDataTransformer` is used which has the below `encode` & `decode` features
   * - `encode`:
   *    - If event body is a Buffer, then the event is sent without any data transformation
   *    - Else, JSON.stringfy() is run on the body, and then converted to Buffer before sending the event
   *    - If JSON.stringify() fails at this point, the send operation fails too.
   * - `decode`
   *    - The body receivied via the AMQP protocol is always of type Buffer
   *    - UTF-8 encoding is used to convert Buffer to string, and then JSON.parse() is run on it to get the event body
   *    - If the JSON.parse() fails at this point, then the originally received Buffer object is returned in the event body.
   */
  dataTransformer?: DataTransformer;
  /**
   * @property
   * The user agent that will be appended to the built in user agent string that is passed as a
   * connection property to the Event Hubs service.
   */
  userAgent?: string;
  /**
   * @property
   * The WebSocket constructor used to create an AMQP connection over a WebSocket.
   * This option should be provided in the below scenarios:
   * - The TCP port 5671 which is what is used by the AMQP connection to Event Hubs is blocked in your environment.
   * - Your application needs to be run behind a proxy server
   * - Your application needs to run in the browser and you want to provide your own choice of Websocket implementation
   * instead of the built-in WebSocket in the browser.
   */
  webSocket?: WebSocketImpl;
  /**
   * @property
   * Options to be passed to the WebSocket constructor when the underlying `rhea` library instantiates
   * the WebSocket.
   */
  webSocketConstructorOptions?: any;
  /**
   * @property
   * The retry options for all the operations on the client/producer/consumer.
   * This can be overridden by the retry options set on the producer and consumer.
   */
  retryOptions?: RetryOptions;
}

/**
 * @class
 * The client is the main point of interaction with Azure Event Hubs service.
 * It offers connection to a specific Event Hub within the Event Hubs namespace along with
 * operations for sending event data, receiving events, and inspecting the connected Event Hub.
 * 
 * There are multiple ways to create an `EventHubClient`
 * - Use the connection string from the SAS policy created for your Event Hub instance.
 * - Use the connection string from the SAS policy created for your Event Hub namespace, 
 * and the name of the Event Hub instance
 * - Use the fully qualified domain name of your Event Hub namespace like `<yournamespace>.servicebus.windows.net`,
 * and a credentials object.
 * 
 */
export class EventHubClient {
  /**
   * Describes the amqp connection context for the eventhub client.
   */
  private _context: ConnectionContext;

  /**
   * The options passed by the user when creating the EventHubClient instance.
   */
  private _clientOptions: EventHubClientOptions;

  /**
   * @property
   * @readonly
   * The name of the Event Hub instance for which this client is created.
   */
  get eventHubName(): string {
    return this._context.config.entityPath;
  }

  /**
   * @constructor
   * @param connectionString - The connection string to use for connecting to the Event Hubs namespace.
   * It is expected that the shared key properties and the Event Hub path are contained in this connection string.
   * e.g. 'Endpoint=sb://my-servicebus-namespace.servicebus.windows.net/;SharedAccessKeyName=my-SA-name;SharedAccessKey=my-SA-key;EntityPath=my-event-hub-name'.
   * @param options - A set of options to apply when configuring the client.
   * - `dataTransformer`: A set of `encode`/`decode` methods to be used to encode an event before sending to service
   * and to decode the event received from the service
   * - `userAgent`      : A string to append to the built in user agent string that is passed as a connection property
   * to the service.
   * - `websocket`      : The WebSocket constructor used to create an AMQP connection if you choose to make the connection
   * over a WebSocket.
   * - `webSocketConstructorOptions` : Options to pass to the Websocket constructor when you choose to make the connection
   * over a WebSocket.
   * - `retryOptions`   : The retry options for all the operations on the client/producer/consumer.
   * A simple usage can be `{ "maxRetries": 4 }`.
   */
  constructor(connectionString: string, options?: EventHubClientOptions);
  /**
   * @constructor
   * @param connectionString - The connection string to use for connecting to the Event Hubs namespace;
   * it is expected that the shared key properties are contained in this connection string, but not the Event Hub path,
   * e.g. 'Endpoint=sb://my-servicebus-namespace.servicebus.windows.net/;SharedAccessKeyName=my-SA-name;SharedAccessKey=my-SA-key;'.
   * @param eventHubName - The path of the specific Event Hub to connect the client to.
   * @param options - A set of options to apply when configuring the client.
   * - `dataTransformer`: A set of `encode`/`decode` methods to be used to encode an event before sending to service
   * and to decode the event received from the service
   * - `userAgent`      : A string to append to the built in user agent string that is passed as a connection property
   * to the service.
   * - `websocket`      : The WebSocket constructor used to create an AMQP connection if you choose to make the connection
   * over a WebSocket.
   * - `webSocketConstructorOptions` : Options to pass to the Websocket constructor when you choose to make the connection
   * over a WebSocket.
   * - `retryOptions`   : The retry options for all the operations on the client/producer/consumer.
   * A simple usage can be `{ "maxRetries": 4 }`.
   */
  constructor(connectionString: string, eventHubName: string, options?: EventHubClientOptions);
  /**
   * @constructor
   * @param host - The fully qualified host name for the Event Hubs namespace. This is likely to be similar to
   * <yournamespace>.servicebus.windows.net
   * @param eventHubName - The path of the specific Event Hub to connect the client to.
   * @param credential - SharedKeyCredential object or your credential that implements the TokenCredential interface.
   * @param options - A set of options to apply when configuring the client.
   * - `dataTransformer`: A set of `encode`/`decode` methods to be used to encode an event before sending to service
   * and to decode the event received from the service
   * - `userAgent`      : A string to append to the built in user agent string that is passed as a connection property
   * to the service.
   * - `websocket`      : The WebSocket constructor used to create an AMQP connection if you choose to make the connection
   * over a WebSocket.
   * - `webSocketConstructorOptions` : Options to pass to the Websocket constructor when you choose to make the connection
   * over a WebSocket.
   * - `retryOptions`   : The retry options for all the operations on the client/producer/consumer.
   * A simple usage can be `{ "maxRetries": 4 }`.
   */
  constructor(
    host: string,
    eventHubName: string,
    credential: TokenCredential,
    options?: EventHubClientOptions
  );
  constructor(
    hostOrConnectionString: string,
    eventHubNameOrOptions?: string | EventHubClientOptions,
    credentialOrOptions?: TokenCredential | EventHubClientOptions,
    options?: EventHubClientOptions
  ) {
    let connectionString;
    let config;
    let credential: TokenCredential | SharedKeyCredential;
    hostOrConnectionString = String(hostOrConnectionString);

    if (!isTokenCredential(credentialOrOptions)) {
      const parsedCS = parseConnectionString<EventHubConnectionStringModel>(hostOrConnectionString);
      if (
        !(
          parsedCS.EntityPath ||
          (typeof eventHubNameOrOptions === "string" && eventHubNameOrOptions)
        )
      ) {
        throw new TypeError(
          `Either provide "eventHubName" or the "connectionString": "${hostOrConnectionString}", ` +
            `must contain "EntityPath=<your-event-hub-name>".`
        );
      }
      if (
        parsedCS.EntityPath &&
        typeof eventHubNameOrOptions === "string" &&
        eventHubNameOrOptions &&
        parsedCS.EntityPath !== eventHubNameOrOptions
      ) {
        throw new TypeError(
          `The entity path "${parsedCS.EntityPath}" in connectionString: "${hostOrConnectionString}" ` +
            `doesn't match with eventHubName: "${eventHubNameOrOptions}".`
        );
      }
      connectionString = hostOrConnectionString;
      if (typeof eventHubNameOrOptions !== "string") {
        // connectionstring and/or options were passed to constructor
        config = EventHubConnectionConfig.create(connectionString);
        options = eventHubNameOrOptions;
      } else {
        // connectionstring, eventHubName and/or options were passed to constructor
        const eventHubName = eventHubNameOrOptions;
        config = EventHubConnectionConfig.create(connectionString, eventHubName);
        options = credentialOrOptions;
      }
      // Since connectionstring was passed, create a SharedKeyCredential
      credential = new SharedKeyCredential(config.sharedAccessKeyName, config.sharedAccessKey);
    } else {
      // host, eventHubName, a TokenCredential and/or options were passed to constructor
      const eventHubName = eventHubNameOrOptions;
      let host = hostOrConnectionString;
      credential = credentialOrOptions;
      if (!eventHubName) {
        throw new TypeError(`"eventHubName" is missing`);
      }

      if (!host.endsWith("/")) host += "/";
      connectionString = `Endpoint=sb://${host};SharedAccessKeyName=defaultKeyName;SharedAccessKey=defaultKeyValue;EntityPath=${eventHubName}`;
      config = EventHubConnectionConfig.create(connectionString);
    }

    ConnectionConfig.validate(config);

    this._clientOptions = options || {};
    this._context = ConnectionContext.create(config, credential, this._clientOptions);
  }

  /**
   * Closes the AMQP connection to the Event Hub instance,
   * returning a promise that will be resolved when disconnection is completed.
   * @returns Promise<void>
   * @throws {Error} Thrown if the underlying connection encounters an error while closing.
   */
  async close(): Promise<void> {
    try {
      if (this._context.connection.isOpen()) {
        // Close all the senders.
        for (const senderName of Object.keys(this._context.senders)) {
          await this._context.senders[senderName].close();
        }
        // Close all the receivers.
        for (const receiverName of Object.keys(this._context.receivers)) {
          await this._context.receivers[receiverName].close();
        }
        // Close the cbs session;
        await this._context.cbsSession.close();
        // Close the management session
        await this._context.managementSession!.close();
        await this._context.connection.close();
        this._context.wasConnectionCloseCalled = true;
        log.client("Closed the amqp connection '%s' on the client.", this._context.connectionId);
      }
    } catch (err) {
      err = err instanceof Error ? err : JSON.stringify(err);
      log.error(
        `An error occurred while closing the connection "${this._context.connectionId}":\n${err}`
      );
      throw err;
    }
  }

  /**
   * Creates an Event Hub producer that can send events to the Event Hub.
   * If `partitionId` is specified in the `options`, all event data sent using the producer
   * will be sent to the specified partition.
   * Otherwise, they are automatically routed to an available partition by the Event Hubs service.
   *
   * Automatic routing of partitions is recommended because:
   *  - The sending of events will be highly available.
   *  - The event data will be evenly distributed among all available partitions.
   *
   * @param options The set of options to apply when creating the producer.
   * - `partitionId`  : The identifier of the partition that the producer can be bound to.
   * - `retryOptions` : The retry options used to govern retry attempts when an issue is encountered while sending events.
   * A simple usage can be `{ "maxRetries": 4 }`.
   *
   * @throws {Error} Thrown if the underlying connection has been closed, create a new EventHubClient.
   * @returns EventHubProducer
   */
  createProducer(options?: EventHubProducerOptions): EventHubProducer {
    if (!options) {
      options = {};
    }
    if (!options.retryOptions) {
      options.retryOptions = this._clientOptions.retryOptions;
    }
    throwErrorIfConnectionClosed(this._context);
    return new EventHubProducer(this._context, options);
  }

  /**
   * Creates an Event Hub consumer that can receive events from a specific Event Hub partition,
   * in the context of a specific consumer group.
   *
   * Multiple consumers are allowed on the same partition in a consumer group.
   * If there is a need to have an exclusive consumer for a partition in a consumer group,
   * then specify the `ownerLevel` in the `options`.
   * Exclusive consumers were previously referred to as "Epoch Receivers".
   *
   * @param consumerGroup The name of the consumer group this consumer is associated with.
   * Events are read in the context of this group. You can get this information from Azure portal.
   * @param partitionId The identifier of the Event Hub partition from which events will be received.
   * You can get identifiers for all partitions by using the `getPartitionProperties` method on the `EventHubClient`.
   * @param eventPosition The position within the partition where the consumer should begin reading events.
   * The easiest way to create an instance of EventPosition is to use the static helpers on it like
   * - `EventPosition.fromOffset()`
   * - `EventPosition.fromSequenceNumber()`
   * - `EventPosition.fromEnqueuedTime()`
   * - `EventPosition.earliest()`
   * - `EventPosition.latest()`
   * @param options The set of options to apply when creating the consumer.
   * - `ownerLevel`  : A number indicating that the consumer intends to be an exclusive consumer of events resulting in other
   * consumers to fail if their `ownerLevel` is lower or doesn't exist.
   * - `retryOptions`: The retry options used to govern retry attempts when an issue is encountered while receiving events.
   * A simple usage can be `{ "maxRetries": 4 }`.
   *
   * @throws {Error} Thrown if the underlying connection has been closed, create a new EventHubClient.
   * @throws {TypeError} Thrown if a required parameter is missing.
   */
  createConsumer(
    consumerGroup: string,
    partitionId: string,
    eventPosition: EventPosition,
    options?: EventHubConsumerOptions
  ): EventHubConsumer {
    if (!options) {
      options = {};
    }
    if (!options.retryOptions) {
      options.retryOptions = this._clientOptions.retryOptions;
    }
    throwErrorIfConnectionClosed(this._context);
    throwTypeErrorIfParameterMissing(this._context.connectionId, "consumerGroup", consumerGroup);
    throwTypeErrorIfParameterMissing(this._context.connectionId, "partitionId", partitionId);
    throwTypeErrorIfParameterMissing(this._context.connectionId, "eventPosition", eventPosition);
    partitionId = String(partitionId);
    return new EventHubConsumer(this._context, consumerGroup, partitionId, eventPosition, options);
  }

  /**
   * Provides the Event Hub runtime information.
   * @param abortSignal An implementation of the `AbortSignalLike` interface to signal the request to cancel the operation.
   * For example, use the &commat;azure/abort-controller to create an `AbortSignal`.
   * @returns A promise that resolves with EventHubProperties.
   * @throws {Error} Thrown if the underlying connection has been closed, create a new EventHubClient.
   * @throws {AbortError} Thrown if the operation is cancelled via the abortSignal.
   */
  async getProperties(abortSignal?: AbortSignalLike): Promise<EventHubProperties> {
    throwErrorIfConnectionClosed(this._context);
    try {
      return await this._context.managementSession!.getHubRuntimeInformation({
        retryOptions: this._clientOptions.retryOptions,
        abortSignal
      });
    } catch (err) {
      log.error("An error occurred while getting the hub runtime information: %O", err);
      throw err;
    }
  }

  /**
   * Provides an array of partitionIds.
   * @param abortSignal An implementation of the `AbortSignalLike` interface to signal the request to cancel the operation.
   * For example, use the &commat;azure/abort-controller to create an `AbortSignal`.
   * @returns A promise that resolves with an Array of strings.
   * @throws {Error} Thrown if the underlying connection has been closed, create a new EventHubClient.
   * @throws {AbortError} Thrown if the operation is cancelled via the abortSignal.
   */
  async getPartitionIds(abortSignal?: AbortSignalLike): Promise<Array<string>> {
    throwErrorIfConnectionClosed(this._context);
    try {
      const runtimeInfo = await this.getProperties(abortSignal);
      return runtimeInfo.partitionIds;
    } catch (err) {
      log.error("An error occurred while getting the partition ids: %O", err);
      throw err;
    }
  }

  /**
   * Provides information about the specified partition.
   * @param partitionId Partition ID for which partition information is required.
   * @param abortSignal An implementation of the `AbortSignalLike` interface to signal the request to cancel the operation.
   * For example, use the &commat;azure/abort-controller to create an `AbortSignal`.
   * @returns A promise that resoloves with PartitionProperties.
   * @throws {Error} Thrown if the underlying connection has been closed, create a new EventHubClient.
   * @throws {AbortError} Thrown if the operation is cancelled via the abortSignal.
   */
  async getPartitionProperties(
    partitionId: string,
    abortSignal?: AbortSignalLike
  ): Promise<PartitionProperties> {
    throwErrorIfConnectionClosed(this._context);
    throwTypeErrorIfParameterMissing(this._context.connectionId, "partitionId", partitionId);
    partitionId = String(partitionId);
    try {
      return await this._context.managementSession!.getPartitionProperties(partitionId, {
        retryOptions: this._clientOptions.retryOptions,
        abortSignal
      });
    } catch (err) {
      log.error("An error occurred while getting the partition information: %O", err);
      throw err;
    }
  }

  /**
   * Creates an EventHubClient from connection string.
   * @param iothubConnectionString - Connection string of the form 'HostName=iot-host-name;SharedAccessKeyName=my-SA-name;SharedAccessKey=my-SA-key'.
   * @param [options] Options that can be provided during client creation.
   * @returns - Promise<EventHubClient>.
   * @throws {Error} Thrown if the iothubConnectionString is not provided as a string.
   */
  static async createFromIotHubConnectionString(
    iothubConnectionString: string,
    options?: EventHubClientOptions
  ): Promise<EventHubClient> {
    if (
      !iothubConnectionString ||
      (iothubConnectionString && typeof iothubConnectionString !== "string")
    ) {
      throw new Error("'connectionString' is a required parameter and must be of type: 'string'.");
    }
    const connectionString = await new IotHubClient(
      iothubConnectionString
    ).getEventHubConnectionString();
    return new EventHubClient(connectionString, options);
  }

  /**
   * @property
   * The name of the default consumer group in the Event Hubs service.
   */
  static defaultConsumerGroupName: string = Constants.defaultConsumerGroup;
}
