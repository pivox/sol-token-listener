export interface ExecutionDecisionEventTestClient {
  readonly query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
}

export async function insertExecutionDecisionEvent(
  client: ExecutionDecisionEventTestClient,
  eventId: string,
  mint: string,
): Promise<void> {
  await client.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,
    transaction_index,instruction_index,inner_instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES (
    $1,NULL,'PaperStrategySessionUpdated',$2,'test-fixture','test-fixture',$1,0,
    0,0,NULL,'finalized',TIMESTAMPTZ 'epoch',1,'{}'::JSONB
  ) ON CONFLICT (event_id) DO NOTHING`, [eventId, mint]);
}
