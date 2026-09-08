# Lean Example

Here is a Lean code block:

```lean
def hello : String := "Hello, Lean!"
```

## Example from verso's homepage

```lean
def Set (α : Type u) : Type u :=
  α → Prop

instance : Membership α (Set α) where
  mem xs x := xs x
```

A function $f$ is surjective if each element of the range is covered by an element of the domain:

```lean
def Surjective (f : α → β) :=
  ∀ y, ∃ x, f x = y
```

```lean
theorem cantor (f : S → Set S) : ¬ Surjective f := by
  intro h
  have ⟨x, p⟩ := h (fun x : S => x ∉ f x)
  have : x ∈ f x ↔ x ∉ f x := by
    constructor <;>
    simp [Membership.mem] at * <;>
    grind
  grind
```

> A nested code block in a blockquote:
>
> ```lean
> def nestedHello (name : String) : String := "Nested " ++ name
> ```

Here is a non-Lean code block to ensure it is ignored by leandown:

```javascript
const message = "Hello, JavaScript!";
console.log(message);
```

## Basic Functionality

Let's evaluate some expressions and check some types:

```lean
-- A line comment
/-- A doc comment for `answer`. -/
def answer : Nat := 42 -- trailing comment

/- A block
   comment -/
#eval 1 + 1
#check Nat.add
#check "Hello"
#check "-- not a comment"
#eval IO.println "Line 1\nLine 2\nLine 3"
```

## Errors and Warnings

Here is a Lean block with an error and a warning:

```lean
def badAdd : Nat := "hello" + 1

def unusedWarning : Nat :=
  let x := 5
  10
```
