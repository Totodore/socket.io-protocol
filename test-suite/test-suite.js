import { decode, encode } from "notepack.io";
const isNodejs = typeof window === "undefined";

if (isNodejs) {
  // make the tests runnable in both the browser and Node.js
  await import("./node-imports.js");
}

const { expect } = chai;

const URL = "http://localhost:3000";
const WS_URL = URL.replace("http", "ws");

const PING_INTERVAL = 300;
const PING_TIMEOUT = 200;

function sleep(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function waitFor(socket, eventType) {
  if (eventType == "message" && isNodejs) {
    const { value: data } = await socket.iterator().next();
    return { data };
  }

  return new Promise((resolve) => {
    socket.addEventListener(
      eventType,
      (event) => {
        resolve(event);
      },
      { once: true }
    );
  });
}

async function waitForPackets(socket, count) {
  const packets = [];
  if (isNodejs) {
    for await (const packet of socket.iterator()) {
      packets.push(packet);
      if (packets.length === count) {
        return packets;
      }
    }
  }

  return new Promise((resolve) => {
    const handler = (event) => {
      if (event.data === "2") {
        // ignore PING packets
        return;
      }
      packets.push(event.data);
      if (packets.length === count) {
        socket.removeEventListener("message", handler);
        resolve(packets);
      }
    };
    socket.addEventListener("message", handler);
  });
}

async function initLongPollingSession() {
  const response = await fetch(`${URL}/socket.io/?EIO=4&transport=polling`);
  const content = await response.text();
  return JSON.parse(content.substring(1)).sid;
}

async function initSocketIOConnection() {
  const socket = new WebSocket(
    `${WS_URL}/socket.io/?EIO=4&transport=websocket`
  );
  socket.binaryType = "arraybuffer";

  await waitFor(socket, "message"); // Engine.IO handshake

  socket.send(encode({ type: 0, nsp: "/" }));

  await waitFor(socket, "message"); // Socket.IO handshake
  await waitFor(socket, "message"); // "auth" packet

  return socket;
}

describe("Engine.IO protocol", () => {
  describe("handshake", () => {
    describe("HTTP long-polling", () => {
      it("should successfully open a session", async () => {
        const response = await fetch(
          `${URL}/socket.io/?EIO=4&transport=polling`
        );

        expect(response.status).to.eql(200);

        const content = await response.text();

        expect(content).to.startsWith("0");

        const value = JSON.parse(content.substring(1));

        expect(value).to.have.all.keys(
          "sid",
          "upgrades",
          "pingInterval",
          "pingTimeout",
          "maxPayload"
        );
        expect(value.sid).to.be.a("string");
        expect(value.upgrades).to.eql(["websocket"]);
        expect(value.pingInterval).to.eql(PING_INTERVAL);
        expect(value.pingTimeout).to.eql(PING_TIMEOUT);
        expect(value.maxPayload).to.eql(1000000);
      });

      it("should fail with an invalid 'EIO' query parameter", async () => {
        const response = await fetch(`${URL}/socket.io/?transport=polling`);

        expect(response.status).to.eql(400);

        const response2 = await fetch(
          `${URL}/socket.io/?EIO=abc&transport=polling`
        );

        expect(response2.status).to.eql(400);
      });

      it("should fail with an invalid 'transport' query parameter", async () => {
        const response = await fetch(`${URL}/socket.io/?EIO=4`);

        expect(response.status).to.eql(400);

        const response2 = await fetch(`${URL}/socket.io/?EIO=4&transport=abc`);

        expect(response2.status).to.eql(400);
      });

      it("should fail with an invalid request method", async () => {
        const response = await fetch(
          `${URL}/socket.io/?EIO=4&transport=polling`,
          {
            method: "post",
          }
        );

        expect(response.status).to.eql(400);

        const response2 = await fetch(
          `${URL}/socket.io/?EIO=4&transport=polling`,
          {
            method: "put",
          }
        );

        expect(response2.status).to.eql(400);
      });
    });

    describe("WebSocket", () => {
      it("should successfully open a session", async () => {
        const socket = new WebSocket(
          `${WS_URL}/socket.io/?EIO=4&transport=websocket`
        );

        const { data } = await waitFor(socket, "message");

        expect(data).to.startsWith("0");

        const value = JSON.parse(data.substring(1));

        expect(value).to.have.all.keys(
          "sid",
          "upgrades",
          "pingInterval",
          "pingTimeout",
          "maxPayload"
        );
        expect(value.sid).to.be.a("string");
        expect(value.upgrades).to.eql([]);
        expect(value.pingInterval).to.eql(PING_INTERVAL);
        expect(value.pingTimeout).to.eql(PING_TIMEOUT);
        expect(value.maxPayload).to.eql(1000000);

        socket.close();
      });

      it("should fail with an invalid 'EIO' query parameter", async () => {
        const socket = new WebSocket(
          `${WS_URL}/socket.io/?transport=websocket`
        );

        if (isNodejs) {
          socket.on("error", () => {});
        }

        waitFor(socket, "close");

        const socket2 = new WebSocket(
          `${WS_URL}/socket.io/?EIO=abc&transport=websocket`
        );

        if (isNodejs) {
          socket2.on("error", () => {});
        }

        waitFor(socket2, "close");
      });

      it("should fail with an invalid 'transport' query parameter", async () => {
        const socket = new WebSocket(`${WS_URL}/socket.io/?EIO=4`);

        if (isNodejs) {
          socket.on("error", () => {});
        }

        waitFor(socket, "close");

        const socket2 = new WebSocket(
          `${WS_URL}/socket.io/?EIO=4&transport=abc`
        );

        if (isNodejs) {
          socket2.on("error", () => {});
        }

        waitFor(socket2, "close");
      });
    });
  });

  describe("heartbeat", function () {
    this.timeout(5000);

    describe("HTTP long-polling", () => {
      it("should send ping/pong packets", async () => {
        const sid = await initLongPollingSession();

        for (let i = 0; i < 3; i++) {
          const pollResponse = await fetch(
            `${URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`
          );

          expect(pollResponse.status).to.eql(200);

          const pollContent = await pollResponse.text();

          expect(pollContent).to.eql("2");

          const pushResponse = await fetch(
            `${URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
            {
              method: "post",
              body: "3",
            }
          );

          expect(pushResponse.status).to.eql(200);
        }
      });

      it("should close the session upon ping timeout", async () => {
        const sid = await initLongPollingSession();

        await sleep(PING_INTERVAL + PING_TIMEOUT);

        const pollResponse = await fetch(
          `${URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`
        );

        expect(pollResponse.status).to.eql(400);
      });
    });

    describe("WebSocket", () => {
      it("should send ping/pong packets", async () => {
        const socket = new WebSocket(
          `${WS_URL}/socket.io/?EIO=4&transport=websocket`
        );

        await waitFor(socket, "message"); // handshake

        for (let i = 0; i < 3; i++) {
          const { data } = await waitFor(socket, "message");

          expect(data).to.eql("2");

          socket.send("3");
        }

        socket.close();
      });

      it("should close the session upon ping timeout", async () => {
        const socket = new WebSocket(
          `${WS_URL}/socket.io/?EIO=4&transport=websocket`
        );

        await waitFor(socket, "close"); // handshake
      });
    });
  });

  describe("close", () => {
    describe("HTTP long-polling", () => {
      it("should forcefully close the session", async () => {
        const sid = await initLongPollingSession();

        const [pollResponse] = await Promise.all([
          fetch(`${URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`),
          fetch(`${URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
            method: "post",
            body: "1",
          }),
        ]);

        expect(pollResponse.status).to.eql(200);

        const pullContent = await pollResponse.text();

        expect(pullContent).to.eql("6");

        const pollResponse2 = await fetch(
          `${URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`
        );

        expect(pollResponse2.status).to.eql(400);
      });
    });

    describe("WebSocket", () => {
      it("should forcefully close the session", async () => {
        const socket = new WebSocket(
          `${WS_URL}/socket.io/?EIO=4&transport=websocket`
        );

        await waitFor(socket, "message"); // handshake

        socket.send("1");

        await waitFor(socket, "close");
      });
    });
  });

  describe("upgrade", () => {
    it("should successfully upgrade from HTTP long-polling to WebSocket", async () => {
      const sid = await initLongPollingSession();

      const socket = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket&sid=${sid}`
      );

      await waitFor(socket, "open");

      // send probe
      socket.send("2probe");

      const probeResponse = await waitFor(socket, "message");

      expect(probeResponse.data).to.eql("3probe");

      // complete upgrade
      socket.send("5");
    });

    it("should ignore HTTP requests with same sid after upgrade", async () => {
      const sid = await initLongPollingSession();

      const socket = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket&sid=${sid}`
      );

      await waitFor(socket, "open");
      socket.send("2probe");
      socket.send("5");

      const pollResponse = await fetch(
        `${URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`
      );

      expect(pollResponse.status).to.eql(400);
    });

    it("should ignore WebSocket connection with same sid after upgrade", async () => {
      const sid = await initLongPollingSession();

      const socket = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket&sid=${sid}`
      );

      await waitFor(socket, "open");
      socket.send("2probe");
      socket.send("5");

      const socket2 = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket&sid=${sid}`
      );

      await waitFor(socket2, "close");
    });
  });
});

describe("Socket.IO protocol", () => {
  describe("connect", () => {
    it("should allow connection to the main namespace", async () => {
      const socket = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`
      );

      await waitFor(socket, "message"); // Engine.IO handshake

      socket.send(encode({ type: 0, nsp: "/", data: undefined }));

      const { data } = await waitFor(socket, "message");
      const handshake = decode(data);
      expect(handshake).to.have.all.keys("data", "type", "nsp");
      expect(handshake.data.sid).to.be.a("string");
      expect(handshake.type).to.eq(0);
      expect(handshake.nsp).to.eq("/");

      const authPacket = decode((await waitFor(socket, "message")).data);
      expect(authPacket).to.eql({ type: 2, nsp: "/", data: ["auth", null] });
    });

    it("should allow connection to the main namespace with a payload", async () => {
      const socket = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`
      );

      await waitFor(socket, "message"); // Engine.IO handshake

      socket.send(encode({ type: 0, nsp: "/", data: { token: "123" } }));

      const { data } = await waitFor(socket, "message");
      const handshake = decode(data);
      expect(handshake).to.have.all.keys("data", "type", "nsp");
      expect(handshake.data.sid).to.be.a("string");
      expect(handshake.type).to.eq(0);
      expect(handshake.nsp).to.eq("/");

      const authPacket = decode((await waitFor(socket, "message")).data);
      expect(authPacket).to.eql({
        type: 2,
        nsp: "/",
        data: ["auth", { token: "123" }],
      });
    });

    it("should allow connection to a custom namespace", async () => {
      const socket = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`
      );

      await waitFor(socket, "message"); // Engine.IO handshake
      socket.send(encode({ type: 0, nsp: "/custom" }));

      const { data } = await waitFor(socket, "message");
      const handshake = decode(data);
      expect(handshake).to.have.all.keys("data", "type", "nsp");
      expect(handshake.data.sid).to.be.a("string");
      expect(handshake.type).to.eq(0);
      expect(handshake.nsp).to.eq("/custom");

      const authPacket = decode((await waitFor(socket, "message")).data);
      expect(authPacket).to.eql({
        type: 2,
        nsp: "/custom",
        data: ["auth", null],
      });
    });

    it("should allow connection to a custom namespace with a payload", async () => {
      const socket = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`
      );

      await waitFor(socket, "message"); // Engine.IO handshake
      socket.send(encode({ type: 0, nsp: "/custom", data: { token: "abc" } }));

      const { data } = await waitFor(socket, "message");
      const handshake = decode(data);
      expect(handshake).to.have.all.keys("data", "type", "nsp");
      expect(handshake.data.sid).to.be.a("string");
      expect(handshake.type).to.eq(0);
      expect(handshake.nsp).to.eq("/custom");

      const authPacket = decode((await waitFor(socket, "message")).data);
      expect(authPacket).to.eql({
        type: 2,
        nsp: "/custom",
        data: ["auth", { token: "abc" }],
      });
    });

    it("should disallow connection to an unknown namespace", async () => {
      const socket = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`
      );

      await waitFor(socket, "message"); // Engine.IO handshake
      socket.send(encode({ type: 0, nsp: "/random" }));

      const msg = await waitFor(socket, "message");
      const data = decode(msg.data);
      expect(data).to.eql({
        type: 4,
        nsp: "/random",
        data: { message: "Invalid namespace" },
      });
    });

    it("should disallow connection with an invalid handshake", async () => {
      const socket = new WebSocket(
        `${WS_URL}/socket.io/?EIO=4&transport=websocket`
      );

      await waitFor(socket, "message"); // Engine.IO handshake

      socket.send(new Uint8Array([4, "a", "b", "c"]));

      await waitFor(socket, "close");
    });
  });

  describe("disconnect", () => {
    it("should disconnect from the main namespace", async () => {
      const socket = await initSocketIOConnection();

      socket.send(encode({ type: 1, nsp: "/" }));

      const { data } = await waitFor(socket, "message");
      expect(data).to.eql("2");
    });

    it("should connect then disconnect from a custom namespace", async () => {
      const socket = await initSocketIOConnection();

      await waitFor(socket, "message"); // ping
      socket.send(encode({ type: 0, nsp: "/custom" }));

      await waitFor(socket, "message"); // Socket.IO handshake
      await waitFor(socket, "message"); // auth packet
      socket.send(encode({ type: 1, nsp: "/custom" }));
      socket.send(
        encode({
          type: 2,
          nsp: "/",
          data: ["message", "message to main namespace", "test", 1],
        })
      );
      const a = await waitFor(socket, "message");
      const data = decode(Buffer.from(a.data));
      expect(data).to.eql({
        type: 2,
        nsp: "/",
        data: ["message-back", "message to main namespace", "test", 1],
      });
    });
  });

  describe("acknowledgements", () => {
    it("should emit with an ack expectation", async () => {
      const socket = await initSocketIOConnection();
      socket.send(
        encode({
          type: 2,
          nsp: "/",
          data: ["emit-with-ack", 1, "2", { 3: [true] }],
        })
      );

      const data = decode(Buffer.from((await waitFor(socket, "message")).data));
      expect(data).to.eql({
        type: 2,
        nsp: "/",
        id: 1,
        data: ["emit-with-ack", 1, "2", { 3: [true] }],
      });
      socket.send(
        encode({ type: 3, nsp: "/", id: 1, data: [1, "2", { 3: [true] }] })
      );

      const data2 = decode(
        Buffer.from((await waitFor(socket, "message")).data)
      );
      expect(data2).to.eql({
        type: 2,
        nsp: "/",
        data: ["emit-with-ack", 1, "2", { 3: [true] }],
      });
    });

    it("should emit with a binary ack expectation", async () => {
      const socket = await initSocketIOConnection();
      const BINS = [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])];
      socket.send(
        encode({
          type: 2,
          nsp: "/",
          data: ["emit-with-ack", ...BINS, "test"],
        })
      );

      let packet = decode(Buffer.from((await waitFor(socket, "message")).data));
      expect(packet).to.eql({
        type: 2,
        nsp: "/",
        id: 1,
        data: ["emit-with-ack", ...BINS, "test"],
      });

      socket.send(
        encode({ type: 3, nsp: "/", id: 1, data: [...BINS, "test"] })
      );

      packet = decode(Buffer.from((await waitFor(socket, "message")).data));
      expect(packet).to.eql({
        type: 2,
        nsp: "/",
        data: ["emit-with-ack", ...BINS, "test"],
      });
    });
  });

  describe("message", () => {
    it("should send a plain-text packet", async () => {
      const socket = await initSocketIOConnection();

      socket.send(
        encode({
          type: 2,
          nsp: "/",
          data: ["message", 1, "2", { 3: [true] }],
        })
      );

      const data = decode(Buffer.from((await waitFor(socket, "message")).data));
      expect(data).to.eql({
        type: 2,
        nsp: "/",
        data: ["message-back", 1, "2", { 3: [true] }],
      });
    });

    it("should send a packet with binary attachments", async () => {
      const socket = await initSocketIOConnection();
      const BINS = [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])];

      socket.send(
        encode({
          type: 2,
          nsp: "/",
          data: ["message", ...BINS, "test"],
        })
      );
      const data = decode(Buffer.from((await waitFor(socket, "message")).data));
      expect(data).to.eql({
        type: 2,
        nsp: "/",
        data: ["message-back", ...BINS, "test"],
      });

      socket.close();
    });

    it("should send a plain-text packet with an ack", async () => {
      const socket = await initSocketIOConnection();
      socket.send(
        encode({
          type: 2,
          id: 456,
          nsp: "/",
          data: ["message-with-ack", 1, "2", { 3: [false] }],
        })
      );

      const data = decode(Buffer.from((await waitFor(socket, "message")).data));
      expect(data).to.eql({
        type: 3,
        id: 456,
        nsp: "/",
        data: [1, "2", { 3: [false] }],
      });
    });

    it("should send a packet with binary attachments and an ack", async () => {
      const socket = await initSocketIOConnection();
      const BINS = [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])];

      socket.send(
        encode({
          type: 2,
          nsp: "/",
          id: 789,
          data: ["message-with-ack", ...BINS, "test"],
        })
      );

      const data = decode(Buffer.from((await waitFor(socket, "message")).data));
      expect(data).to.eql({
        type: 3,
        id: 789,
        data: [...BINS, "test"],
        nsp: "/",
      });

      socket.close();
    });

    it("should close the connection upon invalid format (unknown packet type)", async () => {
      const socket = await initSocketIOConnection();
      socket.send("4abc");
      socket.send(Buffer.from([1, 2, 3, 4]));

      await waitFor(socket, "close");
    });

    it("should close the connection upon invalid format (invalid payload format)", async () => {
      const socket = await initSocketIOConnection();

      socket.send("42{}");

      await waitFor(socket, "close");
    });

    it("should close the connection upon invalid format (invalid ack id)", async () => {
      const socket = await initSocketIOConnection();

      socket.send('42abc["message-with-ack",1,"2",{"3":[false]}]');

      await waitFor(socket, "close");
    });
  });
});
