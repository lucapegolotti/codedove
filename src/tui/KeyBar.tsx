import { Box, Text } from "ink";

type Props = { status: "running" | "stopped" };

export function KeyBar({ status }: Props) {
  return (
    <Box paddingX={1} gap={3}>
      {status === "stopped" ? (
        <Text>[s] start</Text>
      ) : (
        <Text>[x] stop</Text>
      )}
      <Text>[r] restart</Text>
      <Text>[c] clear logs</Text>
    </Box>
  );
}
