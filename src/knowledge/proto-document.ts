/** The structured protobuf documentation a graph opinion can publish. */
type ProtoField = { name: string; type: string; id: number; rule: string; oneof?: string };
type ProtoMessage = { name: string; fields: ProtoField[]; values?: {name: string; id: number}[] };
export type ProtoDocumentation = { services: { name: string; methods: {name: string; request: string; response: string; requestStream: boolean; responseStream: boolean}[] }[]; messages: ProtoMessage[] };
