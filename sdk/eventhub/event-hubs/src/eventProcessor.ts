// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import uuid from "uuid/v4";
import { EventHubClient } from "./eventHubClient";
import { EventPosition } from "./eventPosition";
import { PartitionContext } from "./partitionContext";
import { CheckpointManager, Checkpoint } from "./checkpointManager";
import { ReceivedEventData } from "./eventData";
import { PumpManager } from "./pumpManager";
import { AbortController, AbortSignalLike } from "@azure/abort-controller";
import * as log from "./log";
import { PartitionLoadBalancer } from "./partitionLoadBalancer";
import { delay } from "@azure/core-amqp";

/**
 * An enum representing the different reasons for an `EventProcessor` to stop processing
 * events from a partition in a consumer group of an Event Hub instance.
 */
export enum CloseReason {
  /**
   * The PartitionProcessor was shutdown due to some internal or service exception.
   */
  EventHubException = "EventHubException",
  /**
   * Ownership of the partition was lost or transitioned to a new processor instance.
   */
  OwnershipLost = "OwnershipLost",
  /**
   * The EventProcessor was shutdown.
   */
  Shutdown = "Shutdown"
}

/**
 * An interface to be implemented by the user in order to be used by the `EventProcessor` via
 * the `PartitionProcessorFactory` to process events from a partition in a consumer group of an Event Hub instance.
 *
 * The interface supports methods that are called at various points of the lifecyle of processing events
 * from a partition like initialize, error and close.
 *
 */
export interface PartitionProcessor {
  /**
   * This method is called when the `EventProcessor` takes ownership of a new partition and before any
   * events are received.
   *
   * @return {void}
   */
  initialize?(): Promise<void>;
  /**
   * This method is called before the partition processor is closed by the EventProcessor.
   *
   * @param closeReason The reason for closing this partition processor.
   * @return {void}
   */
  close?(reason: CloseReason): Promise<void>;
  /**
   * This method is called when new events are received.
   *
   * This is also a good place to update checkpoints as appropriate.
   *
   * @param eventData The received events to be processed.
   * @return {void}
   */
  processEvents(events: ReceivedEventData[]): Promise<void>;
  /**
   * This method is called when an error occurs while receiving events from Event Hub.
   *
   * @param error The error to be processed.
   * @return {void}
   */
  processError(error: Error): Promise<void>;
}

/**
 * An interface representing the details on which instance of a `EventProcessor` owns processing
 * of a given partition from a consumer group of an Event Hub instance.
 *
 * **Note**: This is used internally by the `EventProcessor` and user never has to create it directly.
 */
export interface PartitionOwnership {
  /**
   * @property The event hub name
   */
  eventHubName: string;
  /**
   * @property The consumer group name
   */
  consumerGroupName: string;
  /**
   * @property The unique identifier of the event processor.
   */
  ownerId: string;
  /**
   * @property The identifier of the Event Hub partition
   */
  partitionId: string;
  /**
   * @property
   * The owner level
   */
  ownerLevel: number;
  /**
   * @property The offset of the event.
   */
  offset?: number;
  /**
   * @property The sequence number of the event.
   */
  sequenceNumber?: number;
  /**
   * @property The last modified time.
   */
  lastModifiedTimeInMS?: number;
  /**
   * @property The unique identifier for the operation.
   */
  eTag?: string;
}

/**
 * `PartitionProcessorFactory` is the interface for the function to be implemented by the user and passed
 * to the constructor of `EventProcessor`.
 * This function acts as a factory that should return an object that implements the `PartitionProcessor`.
 *
 * An instance of `EventProcessor` calls this factory each time it begins processing a new partition
 * from a consumer group of an Event Hub instance.
 */
export interface PartitionProcessorFactory {
  /**
   * Factory method to create a new instance of `PartitionProcessor` for a partition.
   *
   * @param partitionContext The partition context containing partition and Event Hub information. The new instance of
   * `PartitionProcessor` created by this method will be responsible for processing events only for this
   * partition.
   * @param checkpointManager The checkpoint manager for updating checkpoints when events are processed by `PartitionProcessor`.
   *
   * @return A new instance of `PartitionProcessor` responsible for processing events.
   */
  (context: PartitionContext, checkpointManager: CheckpointManager): PartitionProcessor;
}

/**
 * A Partition manager stores and retrieves partition ownership information and checkpoint details
 * for each partition in a given consumer group of an event hub instance.
 *
 * Users are not meant to implement an `PartitionManager`.
 * Users are expected to choose existing implementations of this interface, instantiate it, and pass
 * it to the constructor of `EventProcessor`.
 *
 * To get started, you can use the `InMemoryPartitionManager` which will store the relevant information in memory.
 * But in production, you should choose an implementation of the `PartitionManager` interface that will
 * store the checkpoints and partition ownerships to a durable store instead.
 *
 */
export interface PartitionManager {
  /**
   * Called to get the list of all existing partition ownership from the underlying data store. Could return empty
   * results if there are is no existing ownership information.
   *
   * @param eventHubName The event hub name.
   * @param consumerGroupName The consumer group name.
   * @return A list of partition ownership details of all the partitions that have/had an owner.
   */
  listOwnership(eventHubName: string, consumerGroupName: string): Promise<PartitionOwnership[]>;
  /**
   * Called to claim ownership of a list of partitions. This will return the list of partitions that were owned
   * successfully.
   *
   * @param partitionOwnership The list of partition ownership this instance is claiming to own.
   * @return A list of partitions this instance successfully claimed ownership.
   */
  claimOwnership(partitionOwnership: PartitionOwnership[]): Promise<PartitionOwnership[]>;
  /**
   * Updates the checkpoint in the data store for a partition.
   *
   * @param checkpoint The checkpoint.
   * @return The new eTag on successful update.
   */
  updateCheckpoint(checkpoint: Checkpoint): Promise<string>;
}

/**
 * A set of options to pass to the constructor of `EventProcessor`
 */
export interface EventProcessorOptions {
  /**
   * @property The position from where to start processing events.
   */
  initialEventPosition?: EventPosition;
  /**
   * The max size of the batch of events passed each time to user code for processing.
   */
  maxBatchSize?: number;
  /**
   * The maximum amount of time to wait to build up the requested message count before
   * passing the data to user code for processing. If not provided, it defaults to 60 seconds.
   */
  maxWaitTimeInSeconds?: number;
}

/**
 * Event Processor based application consists of one or more instances of EventProcessor which have been
 * configured to consume events from the same Event Hub and consumer group. Event Processors balance the
 * workload across different instances and track progress when events are processed.
 *
 * `EventProcessor` is a high level construct that
 * - uses an `EventHubClient` to receive events from multiple partitions in a consumer group of
 * an Event Hub instance.
 * - uses a factory method implemented by the user to create new processors for each partition.
 * These processors hold user code to process events.
 * - provides the ability to checkpoint and load balance across multiple instances of itself
 * using the `PartitionManager`.
 *
 * A checkpoint is meant to represent the last successfully processed event by the user from a particular
 * partition of a consumer group in an Event Hub instance.
 *
 * By setting up multiple instances of the `EventProcessor` over different machines, the partitions will be distributed
 * for processing among the different instances. This achieves load balancing.
 *
 * You need the below to create an instance of `EventProcessor`
 * - The name of the consumer group from which you want to process events
 * - An instance of `EventHubClient` that was created for the Event Hub instance.
 * - A factory method that can return an object that implements the `PartitionProcessor` interface.
 * This method should be implemented by the user. For example:
 * (context, checkpointManager) => {
 *    return {
 *      processEvents: (events) => {
 *        // user code here
 *        // use the context to get information on the partition
 *        // use the checkpointManager to update checkpoints if needed
 *       }
 *     }
 * }
 * - An instance of `PartitionManager`. To get started, you can pass an instance of `InMemoryPartitionManager`.
 * For production, choose an implementation that will store checkpoints and partition ownership details to a durable store.
 *
 * @class EventProcessor
 */
export class EventProcessor {
  private _consumerGroupName: string;
  private _eventHubClient: EventHubClient;
  private _partitionProcessorFactory: PartitionProcessorFactory;
  private _processorOptions: EventProcessorOptions;
  private _pumpManager: PumpManager;
  private _id: string = uuid();
  private _isRunning: boolean = false;
  private _loopTask?: PromiseLike<void>;
  private _abortController?: AbortController;
  private _partitionManager: PartitionManager;
  private _partitionLoadBalancer: PartitionLoadBalancer;

  /**
   * @param consumerGroupName The name of the consumer group from which you want to process events
   * @param eventHubClient An instance of `EventHubClient` that was created for the Event Hub instance.
   * @param partitionProcessorFactory A factory method that can return an object that implements the `PartitionProcessor` interface.
   * @param partitionManager An instance of `PartitionManager`. To get started, you can pass an instance of `InMemoryPartitionManager`.
   * For production, choose an implementation that will store checkpoints and partition ownership details to a durable store.
   * @param options A set of options to configure the Event Processor
   * - `initialEventPosition` : The position from where to start processing events.
   * - `maxBatchSize`         : The max size of the batch of events passed each time to user code for processing.
   * - `maxWaitTimeInSeconds` : The maximum amount of time to wait to build up the requested message count before
   * passing the data to user code for processing. If not provided, it defaults to 60 seconds.
   */
  constructor(
    consumerGroupName: string,
    eventHubClient: EventHubClient,
    partitionProcessorFactory: PartitionProcessorFactory,
    partitionManager: PartitionManager,
    options?: EventProcessorOptions
  ) {
    if (!options) options = {};

    this._consumerGroupName = consumerGroupName;
    this._eventHubClient = eventHubClient;
    this._partitionProcessorFactory = partitionProcessorFactory;
    this._partitionManager = partitionManager;
    this._processorOptions = options;
    this._pumpManager = new PumpManager(this._id, options);
    const inactiveTimeLimitInMS = 60000; // ownership expiration time (1 mintue)
    this._partitionLoadBalancer = new PartitionLoadBalancer(this._id, inactiveTimeLimitInMS);
  }

  /**
   * The unique identifier for the EventProcessor.
   *
   * @return {string}
   */
  get id(): string {
    return this._id;
  }

  private _createPartitionOwnershipRequest(
    partitionOwnershipMap: Map<string, PartitionOwnership>,
    partitionIdToClaim: string
  ): PartitionOwnership {
    const previousPartitionOwnership = partitionOwnershipMap.get(partitionIdToClaim);
    const partitionOwnership: PartitionOwnership = {
      ownerId: this._id,
      partitionId: partitionIdToClaim,
      consumerGroupName: this._consumerGroupName,
      eventHubName: this._eventHubClient.eventHubName,
      sequenceNumber: previousPartitionOwnership
        ? previousPartitionOwnership.sequenceNumber
        : undefined,
      offset: previousPartitionOwnership ? previousPartitionOwnership.offset : undefined,
      eTag: previousPartitionOwnership ? previousPartitionOwnership.eTag : undefined,
      ownerLevel: 0
    };

    return partitionOwnership;
  }

  /*
   * Claim ownership of the given partition if it's available
   */
  private async _claimOwnership(
    partitionOwnershipMap: Map<string, PartitionOwnership>,
    partitionIdToClaim: string
  ): Promise<void> {
    log.partitionLoadBalancer(
      `[${this._id}] Attempting to claim ownership of partition ${partitionIdToClaim}.`
    );
    const ownershipRequest = this._createPartitionOwnershipRequest(
      partitionOwnershipMap,
      partitionIdToClaim
    );
    try {
      await this._partitionManager.claimOwnership([ownershipRequest]);
      log.partitionLoadBalancer(
        `[${this._id}] Successfully claimed ownership of partition ${partitionIdToClaim}.`
      );
      const partitionContext: PartitionContext = {
        consumerGroupName: this._consumerGroupName,
        eventHubName: this._eventHubClient.eventHubName,
        partitionId: ownershipRequest.partitionId
      };

      const checkpointManager = new CheckpointManager(
        partitionContext,
        this._partitionManager,
        this._id
      );

      log.partitionLoadBalancer(
        `[${this._id}] [${partitionIdToClaim}] Calling user-provided PartitionProcessorFactory.`
      );
      const partitionProcessor = this._partitionProcessorFactory(
        partitionContext,
        checkpointManager
      );

      const eventPosition = ownershipRequest.sequenceNumber
        ? EventPosition.fromSequenceNumber(ownershipRequest.sequenceNumber)
        : this._processorOptions.initialEventPosition || EventPosition.earliest();

      await this._pumpManager.createPump(
        this._eventHubClient,
        partitionContext,
        eventPosition,
        partitionProcessor
      );
      log.partitionLoadBalancer(`[${this._id}] PartitionPump created successfully.`);
    } catch (err) {
      log.error(
        `[${this.id}] Failed to claim ownership of partition ${ownershipRequest.partitionId}`
      );
    }
  }

  /**
   * Every loop to this method will result in this EventProcessor owning at most one new partition.
   *
   * The load is considered balanced when no active EventProcessor owns 2 partitions more than any other active
   * EventProcessor. Given that each invocation to this method results in ownership claim of at most one partition,
   * this algorithm converges gradually towards a steady state.
   *
   * When a new partition is claimed, this method is also responsible for starting a partition pump that creates an
   * EventHubConsumer for processing events from that partition.
   */

  private async _runLoop(abortSignal: AbortSignalLike): Promise<void> {
    // periodically check if there is any partition not being processed and process it
    const waitIntervalInMs = 10000;
    while (!abortSignal.aborted) {
      try {
        const partitionOwnershipMap: Map<string, PartitionOwnership> = new Map();
        // Retrieve current partition ownership details from the datastore.
        const partitionOwnership = await this._partitionManager.listOwnership(
          this._eventHubClient.eventHubName,
          this._consumerGroupName
        );
        for (const ownership of partitionOwnership) {
          partitionOwnershipMap.set(ownership.partitionId, ownership);
        }
        const partitionIds = await this._eventHubClient.getPartitionIds();
        if (abortSignal.aborted) {
          return;
        }

        if (partitionIds.length > 0) {
          const partitionToClaim = this._partitionLoadBalancer.loadBalance(
            partitionOwnershipMap,
            partitionIds
          );
          if (partitionToClaim) {
            await this._claimOwnership(partitionOwnershipMap, partitionToClaim);
          }
        }

        // sleep
        log.eventProcessor(
          `[${this._id}] Pausing the EventProcessor loop for ${waitIntervalInMs} ms.`
        );
        await delay(waitIntervalInMs, abortSignal);
      } catch (err) {
        log.error(`[${this._id}] An error occured within the EventProcessor loop: ${err}`);
      }
    }
  }

  /**
   * Starts the `EventProcessor`. Based on the number of instances of `EventProcessor` that are running for the
   * same consumer group, the partitions are distributed among these instances to process events.
   *
   * For each partition, the user provided `PartitionProcessorFactory` is called to create a `PartitionProcessor`.
   *
   * Subsequent calls to start will be ignored if this event processor is already running.
   * Calling `start()` after `stop()` is called will restart this event processor.
   *
   * @return {void}
   */
  start(): void {
    if (this._isRunning) {
      log.eventProcessor(`[${this._id}] Attempted to start an already running EventProcessor.`);
      return;
    }

    this._isRunning = true;
    this._abortController = new AbortController();
    log.eventProcessor(`[${this._id}] Starting an EventProcessor.`);
    this._loopTask = this._runLoop(this._abortController.signal);
  }

  /**
   * Stops processing events for all partitions owned by this event processor.
   * All `PartitionProcessor` will be shutdown and any open resources will be closed.
   *
   * Subsequent calls to stop will be ignored if the event processor is not running.
   *
   */
  async stop(): Promise<void> {
    log.eventProcessor(`[${this._id}] Stopping an EventProcessor.`);
    if (this._abortController) {
      // cancel the event processor loop
      this._abortController.abort();
    }

    this._isRunning = false;
    try {
      // remove all existing pumps
      await this._pumpManager.removeAllPumps(CloseReason.Shutdown);

      // waits for the event processor loop to complete
      // will complete immediately if _loopTask is undefined
      await this._loopTask;
    } catch (err) {
      log.error(`[${this._id}] An error occured while stopping the EventProcessor: ${err}`);
    } finally {
      log.eventProcessor(`[${this._id}] EventProcessor stopped.`);
    }
  }
}
