import { describe, expect, it } from "vitest";
import { SessionGateway, stampedFromEnv } from "#src/gateway";

const both = { continueSelf: true, continueChildren: true };

describe("stampedFromEnv", () => {
  it("adopts an out-of-process child stamp", () => {
    expect(stampedFromEnv({ PI_CONTINUE_FOR_CHILD: "1" })).toBe(true);
  });

  it("has no opinion without the stamp", () => {
    expect(stampedFromEnv({})).toBeUndefined();
  });
});

describe("SessionGateway", () => {
  it("starts as a root that may act", () => {
    expect(new SessionGateway().isGatedIn(both)).toBe(true);
  });

  it("follows continueChildren once marked a child", () => {
    const gateway = new SessionGateway();
    gateway.markChild();
    expect(gateway.isGatedIn(both)).toBe(true);
    expect(
      gateway.isGatedIn({ continueSelf: true, continueChildren: false }),
    ).toBe(false);
  });

  it("follows continueSelf in a root", () => {
    expect(
      new SessionGateway().isGatedIn({
        continueSelf: false,
        continueChildren: true,
      }),
    ).toBe(false);
  });

  it("tracks live children and forgets them on any ending", () => {
    const gateway = new SessionGateway();
    gateway.childSpawned("a");
    expect(gateway.hasActiveChildren).toBe(true);
    gateway.childFinished("a");
    expect(gateway.hasActiveChildren).toBe(false);
  });

  it("marks a session driven only while a run is open", () => {
    const gateway = new SessionGateway();
    gateway.runStarted();
    expect(gateway.isDriven()).toBe(true);
    gateway.turnEnded();
    expect(gateway.isDriven()).toBe(true);
  });

  it("measures an idle gap from the last activity", () => {
    const gateway = new SessionGateway();
    expect(gateway.msSinceActivity(100)).toBe(Number.POSITIVE_INFINITY);
    gateway.touch(100);
    expect(gateway.msSinceActivity(250)).toBe(150);
  });

  it("clamps a negative turn depth", () => {
    const gateway = new SessionGateway();
    gateway.turnEnded();
    expect(gateway.isDriven()).toBe(false);
  });
});
