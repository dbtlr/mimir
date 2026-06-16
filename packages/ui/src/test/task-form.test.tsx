import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { TaskForm } from "../components/task-form";

const parents = [
  { id: "MMR-1", label: "build", depth: 0, type: "initiative" as const },
  { id: "MMR-7", label: "Phase 5", depth: 1, type: "phase" as const },
];

describe("TaskForm (create)", () => {
  test("renders the parent picker and blocks submit until a title is entered", () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    expect(screen.getByLabelText(/parent/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
  });

  test("submits parent + normalized fields", async () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/parent/i), { target: { value: "MMR-7" } });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "  hello  " } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ parent: "MMR-7", title: "hello", priority: null, size: null }),
      ),
    );
  });
});

describe("TaskForm (edit)", () => {
  test("hides the parent picker and prefills from initial", () => {
    render(
      <TaskForm
        mode="edit"
        initial={{ title: "existing", priority: "p1" }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/parent/i)).toBeNull();
    expect(screen.getByLabelText(/title/i)).toHaveValue("existing");
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });
});
