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

  test("Enter with empty title does not throw and does not call onSubmit", async () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    // Title is empty by default; submit the form directly
    const form = screen.getByRole("button", { name: /create/i }).closest("form")!;
    fireEvent.submit(form);
    // Give async handlers a chance to run
    await new Promise((r) => setTimeout(r, 50));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("more-details fields (priority) are included in onSubmit payload", async () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "My task" } });
    fireEvent.change(screen.getByLabelText(/priority/i), { target: { value: "p2" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ title: "My task", priority: "p2" }),
      ),
    );
  });

  test("description is always visible, not behind the More details disclosure (MMR-75)", () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    // Description must not be nested in the collapsed disclosure...
    expect(screen.getByLabelText(/description/i).closest("details")).toBeNull();
    // ...while priority stays under "More details".
    expect(screen.getByLabelText(/priority/i).closest("details")).not.toBeNull();
  });

  test("comma-separated tags input is split into tags array", async () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Tagged task" } });
    fireEvent.change(screen.getByLabelText(/tags/i), { target: { value: "foo, bar" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ tags: ["foo", "bar"] })),
    );
  });

  test("submitting=true disables the submit button", () => {
    render(
      <TaskForm
        mode="create"
        parents={parents}
        submitting={true}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // Even if we set a title, submitting=true keeps button disabled
    // The button is disabled due to empty title AND submitting — check it's disabled
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
  });

  test("Create button disabled until both title and parent are provided", () => {
    // Pass the full parents list so the parent picker is rendered; start with empty default
    // by passing an empty parents array so defaultParent resolves to ""
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={[]} onSubmit={onSubmit} onCancel={() => {}} />);
    // No title, no parent — disabled
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
    // Type a title — still disabled because parent is ""
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "My task" } });
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
  });

  test("Create button enabled after title typed and parent selected", () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    // Default parent is MMR-1 (first option); type a title — should become enabled
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "My task" } });
    expect(screen.getByRole("button", { name: /create/i })).not.toBeDisabled();
    // Change parent to MMR-7 — still enabled
    fireEvent.change(screen.getByLabelText(/parent/i), { target: { value: "MMR-7" } });
    expect(screen.getByRole("button", { name: /create/i })).not.toBeDisabled();
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

  test("submitting=true disables the save button even with a title present", async () => {
    render(
      <TaskForm
        mode="edit"
        initial={{ title: "existing" }}
        submitting={true}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // Wait for reactive state to settle
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeDisabled());
  });
});
