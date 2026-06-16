import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ArtifactFilters } from "../components/artifact-filters";

describe("ArtifactFilters", () => {
  test("typing in search fires onChange with q", async () => {
    const onChange = vi.fn();
    render(<ArtifactFilters filters={{}} projects={["MMR", "NOVA"]} onChange={onChange} />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), "auth");
    expect(onChange).toHaveBeenLastCalledWith({ q: "auth" });
  });

  test("selecting a project fires onChange with project", async () => {
    const onChange = vi.fn();
    render(<ArtifactFilters filters={{}} projects={["MMR", "NOVA"]} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText(/project/i), "NOVA");
    expect(onChange).toHaveBeenCalledWith({ project: "NOVA" });
  });
});
