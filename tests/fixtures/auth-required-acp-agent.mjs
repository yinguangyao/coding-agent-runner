#!/usr/bin/env node

import { Readable, Writable } from "node:stream";
import * as acp from "@zed-industries/agent-client-protocol";

process.stdout.write("auth-required fixture startup log\n");

class AuthRequiredAgent {
  constructor(connection) {
    this.connection = connection;
    this.authenticated = false;
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    };
  }

  async authenticate(params) {
    if (params.methodId !== "cursor_login") {
      throw acp.RequestError.invalidParams({ message: `unsupported methodId ${params.methodId}` });
    }
    this.authenticated = true;
    return {};
  }

  async newSession() {
    if (!this.authenticated) {
      throw acp.RequestError.authRequired({
        message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
      });
    }
    return { sessionId: "session-authenticated" };
  }

  async loadSession(params) {
    if (!this.authenticated) {
      throw acp.RequestError.authRequired({
        message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
      });
    }
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "loaded session" },
      },
    });
    return {};
  }

  async prompt(params) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "cursor smoke ok" },
      },
    });
    return { stopReason: "end_turn" };
  }

  async cancel() {}
  async setSessionMode() {
    return {};
  }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((conn) => new AuthRequiredAgent(conn), stream);
