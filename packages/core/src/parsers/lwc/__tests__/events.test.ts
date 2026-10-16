import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { LwcBundleParser } from "../index.js";

/**
 * Platform events (`lightning/empApi`) and Lightning Message Service
 * (`lightning/messageService` + `@salesforce/messageChannel`) produce
 * PUBLISHES_EVENT / SUBSCRIBES_TO_EVENT.
 */
const evts = async (js: string, namespace: string | null = null) =>
  (
    await new LwcBundleParser().parse(
      { bundleName: "cmp", files: { "cmp.js": js } },
      { ...makeTestCtx(), namespace },
    )
  ).edges
    .filter((e) => e.relType === "PUBLISHES_EVENT" || e.relType === "SUBSCRIBES_TO_EVENT")
    .map((e) => `${e.relType}|${String(e.dstQualifiedName)}|${String(e.attributes.via)}`)
    .sort();

describe("LWC: empApi platform events", () => {
  it("subscribe('/event/X__e') from lightning/empApi subscribes to the platform event", async () => {
    expect(
      await evts(`
        import { LightningElement } from 'lwc';
        import { subscribe as empSubscribe, unsubscribe, onError } from 'lightning/empApi';
        const ORDER_CHANNEL = '/event/Order_Placed__e';
        export default class Cmp extends LightningElement {
          channelName = '/event/Shipment__e';
          connectedCallback() {
            empSubscribe('/event/Invoice__e', -1, (m) => {});
            empSubscribe(this.channelName, -1, (m) => {});
            empSubscribe(ORDER_CHANNEL, -1, (m) => {});
            empSubscribe('/data/AccountChangeEvent', -1, (m) => {});
            empSubscribe('/topic/Legacy', -1, (m) => {});
            empSubscribe(this.dynamic, -1, (m) => {});
            unsubscribe(this.subscription, () => {});
          }
        }
      `),
    ).toEqual([
      "SUBSCRIBES_TO_EVENT|PlatformEvent:Invoice__e|empApi",
      "SUBSCRIBES_TO_EVENT|PlatformEvent:Order_Placed__e|empApi",
      "SUBSCRIBES_TO_EVENT|PlatformEvent:Shipment__e|empApi",
    ]);
  });

  it("a subscribe that is not empApi's, or a bare /event/ string, is not a subscription", async () => {
    expect(
      await evts(`
        import { LightningElement } from 'lwc';
        import { subscribe } from 'c/pubsub';
        export default class Cmp extends LightningElement {
          channel = '/event/Ignored__e';
          connectedCallback() { subscribe('/event/NotEmp__e', () => {}); }
        }
      `),
    ).toEqual([]);
  });

  it("strips the org's own namespace from the event name", async () => {
    expect(
      await evts(
        `import { subscribe } from 'lightning/empApi';
         subscribe('/event/acme__Order__e', -1, () => {});`,
        "acme",
      ),
    ).toEqual(["SUBSCRIBES_TO_EVENT|PlatformEvent:Order__e|empApi"]);
  });
});

describe("LWC: Lightning Message Service", () => {
  it("publish / subscribe with an imported message channel", async () => {
    expect(
      await evts(`
        import { LightningElement, wire } from 'lwc';
        import { publish, subscribe, unsubscribe, MessageContext, APPLICATION_SCOPE } from 'lightning/messageService';
        import RECORD_SELECTED from '@salesforce/messageChannel/Record_Selected__c';
        import CART from '@salesforce/messageChannel/Cart_Update__c';
        import UNUSED from '@salesforce/messageChannel/Unused__c';
        export default class Cmp extends LightningElement {
          @wire(MessageContext) messageContext;
          connectedCallback() {
            this.sub = subscribe(this.messageContext, RECORD_SELECTED, (m) => this.handle(m), { scope: APPLICATION_SCOPE });
          }
          select(id) { publish(this.messageContext, CART, { id }); }
          disconnectedCallback() { unsubscribe(this.sub); }
        }
      `),
    ).toEqual([
      "PUBLISHES_EVENT|LightningMessageChannel:Cart_Update|messageService",
      "SUBSCRIBES_TO_EVENT|LightningMessageChannel:Record_Selected|messageService",
    ]);
  });

  it("a channel argument that is not an imported message channel links nothing", async () => {
    expect(
      await evts(`
        import { publish } from 'lightning/messageService';
        import CH from '@salesforce/messageChannel/acme__Picked__c';
        export function send(ctx, other) {
          publish(ctx, other, {});
          publish(ctx, 'Picked__c', {});
          CH.toString();
        }
      `),
    ).toEqual([]);
  });

  it("strips the org's own namespace from the channel", async () => {
    expect(
      await evts(
        `import { publish } from 'lightning/messageService';
         import CH from '@salesforce/messageChannel/acme__Picked__c';
         import OTHER from '@salesforce/messageChannel/other__Shared__c';
         export function send(ctx) { publish(ctx, CH, {}); publish(ctx, OTHER, {}); }`,
        "acme",
      ),
    ).toEqual([
      "PUBLISHES_EVENT|LightningMessageChannel:Picked|messageService",
      "PUBLISHES_EVENT|LightningMessageChannel:other__Shared|messageService",
    ]);
  });
});
