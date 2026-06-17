import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ArtifactFilters } from "../components/artifact-filters";

describe("ArtifactFilters", () => {
  test("typing in search debounces a single onChange with the final q", async () => {
    const onChange = vi.fn();
    render(<ArtifactFilters filters={{}} projects={["MMR", "NOVA"]} onChange={onChange} />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), "auth");
    // The box updates immediately…
    expect(screen.getByPlaceholderText(/search/i)).toHaveValue("auth");
    // …but onChange only fires once typing pauses (debounced — not per keystroke).
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({ q: "auth" });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("search box re-syncs when q changes externally (controlled)", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ArtifactFilters filters={{ q: "auth" }} projects={["MMR"]} onChange={onChange} />,
    );
    expect(screen.getByPlaceholderText(/search/i)).toHaveValue("auth");
    // e.g. Back/Forward or a clear-filters action changes q from outside.
    rerender(<ArtifactFilters filters={{}} projects={["MMR"]} onChange={onChange} />);
    expect(screen.getByPlaceholderText(/search/i)).toHaveValue("");
  });

  test("selecting a project fires onChange with project", async () => {
    const onChange = vi.fn();
    render(<ArtifactFilters filters={{}} projects={["MMR", "NOVA"]} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText(/project/i), "NOVA");
    expect(onChange).toHaveBeenCalledWith({ project: "NOVA" });
  });
});
