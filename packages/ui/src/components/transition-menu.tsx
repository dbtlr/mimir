import { useState } from "react";
import type { WireNode } from "../api/types";
import { useTransition } from "../api/mutations";
import { availableTransitions, type VerbSpec } from "../lib/transitions";
import { MenuContent, MenuItem, MenuLabel, MenuRoot, MenuTrigger } from "./ui/menu";
import { ReasonDialog } from "./reason-dialog";

/**
 * The intervention affordance shared by the card and the drawer: a kebab (⋯)
 * opening the legal transitions for the node's status. Immediate verbs fire on
 * click; park/block/abandon open the reason dialog first. Renders nothing when
 * no transition is legal (terminal). `disabled` (offline) inerts the trigger.
 */
export function TransitionMenu({
  node,
  disabled,
}: {
  node: Pick<WireNode, "id" | "status">;
  disabled?: boolean;
}) {
  const verbs = availableTransitions(node.status);
  const { mutate } = useTransition(node.id);
  const [reasonVerb, setReasonVerb] = useState<VerbSpec | null>(null);

  if (verbs.length === 0) return null;

  return (
    <>
      <MenuRoot>
        <MenuTrigger
          aria-label="Actions"
          disabled={disabled}
          className="flex h-8 w-8 items-center justify-center rounded text-[1.125rem] leading-none text-ink-dim transition-colors hover:bg-well-700 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 md:h-auto md:w-auto md:px-1.5 md:py-0.5 md:text-[0.875rem]"
        >
          ⋯
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Transition</MenuLabel>
          {verbs.map((v) => (
            <MenuItem
              key={v.verb}
              onClick={() => {
                if (v.needsReason) {
                  setReasonVerb(v);
                } else {
                  mutate({ verb: v.verb });
                }
              }}
            >
              {v.label}
            </MenuItem>
          ))}
        </MenuContent>
      </MenuRoot>
      <ReasonDialog
        verb={reasonVerb?.verb ?? null}
        open={reasonVerb !== null}
        onClose={() => {
          setReasonVerb(null);
        }}
        onConfirm={(reason) => {
          if (reasonVerb !== null) {
            mutate(reason === "" ? { verb: reasonVerb.verb } : { verb: reasonVerb.verb, reason });
          }
          setReasonVerb(null);
        }}
      />
    </>
  );
}
